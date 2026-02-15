import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getTelegramApi } from "../telegram";
import logger from "../logger";

const log = logger.child({ module: "social" });
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load static data ────────────────────────────────────────────────────────

interface Quote {
  text: string;
  author: string;
  category?: string;
}

interface Fact {
  text: string;
  category?: string;
}

let quotesCache: Quote[] | null = null;
let factsCache: Fact[] | null = null;

function loadQuotes(): Quote[] {
  if (!quotesCache) {
    quotesCache = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "data", "quotes.json"), "utf-8"));
  }
  return quotesCache!;
}

function loadFacts(): Fact[] {
  if (!factsCache) {
    factsCache = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "data", "facts.json"), "utf-8"));
  }
  return factsCache!;
}

// ── Polls ───────────────────────────────────────────────────────────────────

const createPoll = tool(
  "create_poll",
  "Create a poll in a Telegram chat. Sends an interactive poll that users can vote on.",
  {
    chatId: z.number().describe("Telegram chat ID to send the poll to"),
    question: z.string().describe("The poll question (max 300 characters)"),
    options: z.array(z.string()).min(2).max(10).describe("Poll options (2-10 choices)"),
    isAnonymous: z.boolean().optional().describe("Whether votes are anonymous (default: true)"),
    allowsMultiple: z.boolean().optional().describe("Whether users can select multiple options (default: false)"),
  },
  async ({ chatId, question, options, isAnonymous, allowsMultiple }) => {
    log.info({ tool: "create_poll", chatId, question }, "Tool invoked");

    try {
      const api = getTelegramApi();
      await api.sendPoll(chatId, question, options, {
        is_anonymous: isAnonymous ?? true,
        allows_multiple_answers: allowsMultiple ?? false,
      });

      log.info({ chatId, question }, "Poll sent");
      return { content: [{ type: "text" as const, text: `Poll created: "${question}" with ${options.length} options.` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, chatId }, "Poll creation failed");
      return { content: [{ type: "text" as const, text: `Failed to create poll: ${msg}` }], isError: true };
    }
  }
);

// ── Random Quote ────────────────────────────────────────────────────────────

const randomQuote = tool(
  "random_quote",
  "Get a random inspirational or thought-provoking quote. Optionally filter by category.",
  {
    category: z.string().optional().describe("Filter by category (e.g. 'motivation', 'wisdom', 'humor', 'life', 'science')"),
  },
  async ({ category }) => {
    log.info({ tool: "random_quote", category }, "Tool invoked");

    try {
      let quotes = loadQuotes();
      if (category) {
        const cat = category.toLowerCase();
        const filtered = quotes.filter((q) => q.category?.toLowerCase() === cat);
        if (filtered.length > 0) quotes = filtered;
      }

      const quote = quotes[Math.floor(Math.random() * quotes.length)];
      return { content: [{ type: "text" as const, text: `"${quote.text}"\n— ${quote.author}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Quote fetch failed");
      return { content: [{ type: "text" as const, text: `Failed to get quote: ${msg}` }], isError: true };
    }
  }
);

// ── Random Fact ─────────────────────────────────────────────────────────────

const randomFact = tool(
  "random_fact",
  "Get a random interesting fact. Optionally filter by category.",
  {
    category: z.string().optional().describe("Filter by category (e.g. 'science', 'history', 'nature', 'space', 'human body')"),
  },
  async ({ category }) => {
    log.info({ tool: "random_fact", category }, "Tool invoked");

    try {
      let facts = loadFacts();
      if (category) {
        const cat = category.toLowerCase();
        const filtered = facts.filter((f) => f.category?.toLowerCase() === cat);
        if (filtered.length > 0) facts = filtered;
      }

      const fact = facts[Math.floor(Math.random() * facts.length)];
      return { content: [{ type: "text" as const, text: fact.text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Fact fetch failed");
      return { content: [{ type: "text" as const, text: `Failed to get fact: ${msg}` }], isError: true };
    }
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const SOCIAL_TOOL_NAMES = [
  "mcp__social__create_poll",
  "mcp__social__random_quote",
  "mcp__social__random_fact",
];

export const socialMcpServer = createSdkMcpServer({
  name: "social",
  tools: [createPoll, randomQuote, randomFact],
});
