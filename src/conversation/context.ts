import { query } from "@anthropic-ai/claude-agent-sdk";
import { ConversationStore, estimateTokens } from "./store";
import type { BuiltContext, ContextStatus, StoredMessage } from "./types";
import { BOT_NAME, MAX_CONTEXT_TOKENS, PROTECTED_MESSAGES } from "../constants";
import logger from "../logger";

const log = logger.child({ module: "context" });

const COMPACTION_THRESHOLD = 0.75; // trigger at 75% utilization

export class ContextBuilder {
  constructor(private store: ConversationStore) {}

  buildContext(chatId: number, senderName: string): BuiltContext {
    const messages = this.store.getActiveMessages(chatId);
    const summary = this.store.getActiveSummary(chatId);

    const meta = `[Context: chatId=${chatId}, user="${senderName}"]`;
    const metaTokens = estimateTokens(meta);

    let totalTokens = metaTokens;
    const parts: string[] = [meta];
    let hasSummary = false;

    // Add summary if present
    if (summary) {
      const summaryBlock = `[Conversation summary: ${summary.content}]`;
      totalTokens += estimateTokens(summaryBlock);
      parts.push(summaryBlock);
      hasSummary = true;
    }

    // Get non-summary messages
    const conversationMessages = messages.filter((m) => m.role !== "summary");

    if (conversationMessages.length === 0) {
      return { prompt: parts.join("\n"), totalTokens, messageCount: 0, hasSummary };
    }

    // Build from newest to oldest, respecting token budget
    const budget = MAX_CONTEXT_TOKENS - totalTokens;
    const includedMessages: StoredMessage[] = [];
    let usedTokens = 0;

    for (let i = conversationMessages.length - 1; i >= 0; i--) {
      const msg = conversationMessages[i];
      if (usedTokens + msg.token_estimate > budget) break;
      includedMessages.unshift(msg);
      usedTokens += msg.token_estimate;
    }

    totalTokens += usedTokens;

    if (includedMessages.length <= 1) {
      // Only the latest message
      const latest = includedMessages[0];
      if (latest) {
        const line =
          latest.role === "user"
            ? `${senderName}: ${latest.content}`
            : `${BOT_NAME}: ${latest.content}`;
        parts.push(line);
      }
    } else {
      // Previous messages + latest
      const previous = includedMessages.slice(0, -1);
      const latest = includedMessages[includedMessages.length - 1];

      const pastLines = previous.map((m) =>
        m.role === "user"
          ? `${senderName}: ${m.content}`
          : `${BOT_NAME}: ${m.content}`
      );
      parts.push(`Previous messages:\n${pastLines.join("\n")}`);

      if (latest) {
        const latestLine =
          latest.role === "user"
            ? `${senderName}: ${latest.content}`
            : `${BOT_NAME}: ${latest.content}`;
        parts.push(latestLine);
      }
    }

    return {
      prompt: parts.join("\n\n"),
      totalTokens,
      messageCount: includedMessages.length,
      hasSummary,
    };
  }

  getStatus(chatId: number): ContextStatus {
    const messages = this.store.getActiveMessages(chatId);
    const summary = this.store.getActiveSummary(chatId);
    const totalTokens = messages.reduce((sum, m) => sum + m.token_estimate, 0);
    const nonSummary = messages.filter((m) => m.role !== "summary");

    let oldestMessageAge: number | null = null;
    if (nonSummary.length > 0) {
      oldestMessageAge = Date.now() - nonSummary[0].created_at;
    }

    return {
      messageCount: nonSummary.length,
      totalTokens,
      utilization: totalTokens / MAX_CONTEXT_TOKENS,
      hasSummary: !!summary,
      oldestMessageAge,
    };
  }

  shouldCompact(chatId: number): boolean {
    const tokens = this.store.getActiveTokenCount(chatId);
    return tokens / MAX_CONTEXT_TOKENS >= COMPACTION_THRESHOLD;
  }

  async compact(chatId: number): Promise<{ before: number; after: number } | null> {
    const messages = this.store.getActiveMessages(chatId);
    const nonSummary = messages.filter((m) => m.role !== "summary");

    if (nonSummary.length <= PROTECTED_MESSAGES) {
      log.info({ chatId }, "Not enough messages to compact");
      return null;
    }

    const beforeTokens = messages.reduce((sum, m) => sum + m.token_estimate, 0);

    // Protect the last N messages
    const toCompact = nonSummary.slice(0, -PROTECTED_MESSAGES);
    if (toCompact.length === 0) return null;

    // Gather existing summary if any
    const existingSummary = this.store.getActiveSummary(chatId);
    const existingSummaryText = existingSummary ? existingSummary.content : null;

    // Build compaction prompt
    const messagesToSummarize = toCompact
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n");

    const compactionPrompt = existingSummaryText
      ? `You are a conversation summarizer. Below is an existing summary of earlier conversation, followed by new messages. Produce a single concise summary that incorporates both.

Existing summary:
${existingSummaryText}

New messages to incorporate:
${messagesToSummarize}

Write a concise summary (2-4 paragraphs) capturing key topics, decisions, user preferences, and important context. Omit greetings and filler.`
      : `You are a conversation summarizer. Below are conversation messages. Produce a concise summary.

Messages:
${messagesToSummarize}

Write a concise summary (2-4 paragraphs) capturing key topics, decisions, user preferences, and important context. Omit greetings and filler.`;

    // Call Claude for summarization
    let summaryText = "";
    try {
      for await (const msg of query({
        prompt: compactionPrompt,
        options: {
          systemPrompt: "You are a precise conversation summarizer. Output only the summary, nothing else.",
          maxTurns: 1,
          allowedTools: [],
        },
      })) {
        if (msg.type === "assistant") {
          const content = (msg as any).message.content;
          summaryText = content
            .filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
        }
      }
    } catch (err) {
      log.error({ chatId, err }, "Compaction summarization failed");
      return null;
    }

    if (!summaryText.trim()) {
      log.warn({ chatId }, "Compaction produced empty summary");
      return null;
    }

    // Mark old messages + existing summary as compacted
    const idsToCompact = toCompact.map((m) => m.id);
    if (existingSummary) idsToCompact.push(existingSummary.id);
    this.store.markCompacted(idsToCompact);

    // Store new summary
    this.store.addMessage(chatId, "summary", summaryText.trim());

    const afterTokens = this.store.getActiveTokenCount(chatId);
    log.info(
      { chatId, before: beforeTokens, after: afterTokens, compacted: toCompact.length },
      "Compaction complete"
    );

    return { before: beforeTokens, after: afterTokens };
  }
}
