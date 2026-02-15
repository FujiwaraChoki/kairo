import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Exa from "exa-js";
import { connectWhatsApp } from "./whatsapp/client";
import { whatsappMcpServer, WHATSAPP_TOOL_NAMES } from "./whatsapp/tools";
import { productivityMcpServer, PRODUCTIVITY_TOOL_NAMES } from "./productivity/tools";
import { mediaMcpServer, MEDIA_TOOL_NAMES } from "./media/tools";
import { infoMcpServer, INFO_TOOL_NAMES } from "./info/tools";
import { socialMcpServer, SOCIAL_TOOL_NAMES } from "./social/tools";
import { gmailMcpServer, GMAIL_TOOL_NAMES } from "./gmail/tools";
import { spotifyMcpServer, SPOTIFY_TOOL_NAMES } from "./spotify/tools";
import { notionMcpServer, NOTION_TOOL_NAMES } from "./notion/tools";
import { ensureZele } from "./gmail/zele";
import { startReminderScheduler } from "./productivity/scheduler";
import { setTelegramApi } from "./telegram";
import { chatContext } from "./context-store";
import { hasPendingConfirmation, resolveConfirmation, CONFIRMABLE_TOOLS } from "./confirmation";
import { BOT_TOKEN, BOT_NAME, ENABLE_GROUPS, EXA_API_KEY, SYSTEM_PROMPT, MAX_CONTEXT_TOKENS, OWNER_CHAT_ID } from "./constants";
import { initDatabase, ConversationStore, ContextBuilder } from "./conversation";
import logger from "./logger";

const log = logger.child({ module: "telegram" });

// Allow SDK to wait for inline keyboard confirmations (default timeout is too short)
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = "180000";

if (!BOT_TOKEN) {
  log.fatal("Missing BOT_TOKEN — get one from @BotFather on Telegram");
  process.exit(1);
}

// ── Exa web search ──────────────────────────────────────────────────────────
if (!EXA_API_KEY) log.warn("Missing EXA_API_KEY — web search will be disabled");
const exa = EXA_API_KEY ? new Exa(EXA_API_KEY) : null;

const webSearchTool = tool(
  "web_search",
  "Search the web for current information. Use when you need up-to-date info, recent events, or facts you're unsure about.",
  {
    query: z.string().describe("The search query"),
    numResults: z.number().min(1).max(10).default(5).describe("Number of results (1-10)"),
  },
  async (args) => {
    if (!exa) {
      return { content: [{ type: "text" as const, text: "Web search unavailable — EXA_API_KEY not configured." }], isError: true };
    }
    try {
      const results = await exa.search(args.query, {
        type: "auto",
        numResults: args.numResults,
        contents: { text: { maxCharacters: 3000 } },
      });
      if (!results.results?.length) {
        return { content: [{ type: "text" as const, text: `No results found for: "${args.query}"` }] };
      }
      const formatted = results.results.map((r: any, i: number) => {
        const parts = [`[${i + 1}] ${r.title || "Untitled"}`];
        if (r.url) parts.push(`    URL: ${r.url}`);
        if (r.publishedDate) parts.push(`    Published: ${r.publishedDate}`);
        if (r.text) parts.push(`    ${r.text}`);
        return parts.join("\n");
      }).join("\n\n");
      return { content: [{ type: "text" as const, text: `Search results for "${args.query}":\n\n${formatted}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, query: args.query }, "Exa search failed");
      return { content: [{ type: "text" as const, text: `Search failed: ${msg}` }], isError: true };
    }
  }
);

const searchServer = createSdkMcpServer({ name: "search", tools: [webSearchTool] });

// ── Conversation memory (SQLite-backed) ─────────────────────────────────────

const store = new ConversationStore();
const contextBuilder = new ContextBuilder(store);

// ── Tool call formatting ─────────────────────────────────────────────────────

type ToolAction = { name: string; input: Record<string, any> };

function formatToolLine(t: ToolAction): string {
  switch (t.name) {
    case "web_search":
      return `🔍 Searched the web for "${t.input.query ?? ""}"`;
    case "Read":
      return `📖 Read ${t.input.file_path ?? "file"}`;
    case "Write":
      return `✏️ Wrote ${t.input.file_path ?? "file"}`;
    case "Edit":
      return `✏️ Edited ${t.input.file_path ?? "file"}`;
    case "Glob":
      return `🔎 Found files matching "${t.input.pattern ?? "*"}"`;
    case "Grep":
      return `🔎 Searched for "${t.input.pattern ?? ""}"`;
    case "Bash": {
      const cmd = t.input.command ?? "";
      const short = cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd;
      return `⚡ Ran \`${short}\``;
    }
    case "Skill":
      return `🛠️ Used skill`;
    case "mcp__whatsapp__send_whatsapp_message":
      return `💬 Sent WhatsApp message to ${t.input.contact ?? "contact"}`;
    case "mcp__whatsapp__read_whatsapp_messages":
      return `📩 Read WhatsApp messages from ${t.input.contact ?? "contact"}`;
    case "mcp__whatsapp__list_whatsapp_chats":
      return `📋 Listed WhatsApp chats`;
    case "mcp__whatsapp__search_whatsapp_contacts":
      return `🔎 Searched WhatsApp contacts`;
    case "mcp__search__web_search":
      return `🔍 Searched the web for "${t.input.query ?? ""}"`;
    // Productivity
    case "mcp__productivity__set_reminder":
      return `⏰ Set a reminder: "${t.input.message ?? ""}"`;
    case "mcp__productivity__list_reminders":
      return `📋 Listed reminders`;
    case "mcp__productivity__delete_reminder":
      return `🗑️ Deleted a reminder`;
    case "mcp__productivity__save_note":
      return `📝 Saved note: "${t.input.title ?? ""}"`;
    case "mcp__productivity__search_notes":
      return `🔎 Searched notes${t.input.query ? ` for "${t.input.query}"` : ""}`;
    case "mcp__productivity__delete_note":
      return `🗑️ Deleted a note`;
    // Media
    case "mcp__media__ocr_image":
      return `👁️ Extracted text from image`;
    case "mcp__media__fetch_transcript":
      return `📜 Fetched transcript from ${t.input.url ?? "URL"}`;
    case "mcp__media__text_to_speech":
      return `🔊 Sent voice message`;
    // Info
    case "mcp__info__get_weather":
      return `🌤️ Got weather for ${t.input.location ?? "location"}`;
    case "mcp__info__get_news":
      return `📰 Fetched news from ${t.input.source ?? "BBC"}`;
    case "mcp__info__define_word":
      return `📖 Defined "${t.input.word ?? "word"}"`;
    case "mcp__info__translate_text":
      return `🌐 Translated text to ${t.input.to ?? "language"}`;
    case "mcp__info__wikipedia_search":
      return `📚 Searched Wikipedia for "${t.input.query ?? ""}"`;
    // Social
    case "mcp__social__create_poll":
      return `📊 Created poll: "${t.input.question ?? ""}"`;
    case "mcp__social__random_quote":
      return `💬 Got a random quote`;
    case "mcp__social__random_fact":
      return `🧠 Got a random fact`;
    // Gmail
    case "mcp__gmail__gmail_list":
      return `📧 Listed recent emails`;
    case "mcp__gmail__gmail_search":
      return `🔍 Searched Gmail for "${t.input.query ?? ""}"`;
    case "mcp__gmail__gmail_read":
      return `📨 Read email thread`;
    case "mcp__gmail__gmail_send":
      return `✉️ Sent email to ${t.input.to ?? "recipient"}`;
    case "mcp__gmail__gmail_reply":
      return `↩️ Replied to email thread`;
    case "mcp__gmail__gmail_action":
      return `📧 ${t.input.action ?? "Action"} on email thread`;
    case "mcp__gmail__gmail_labels":
      return `🏷️ Listed Gmail labels`;
    // Spotify
    case "mcp__spotify__spotify_auth":
      return `🎵 Started Spotify connection`;
    case "mcp__spotify__spotify_now_playing":
      return `🎧 Got currently playing track`;
    case "mcp__spotify__spotify_recently_played":
      return `🎧 Got recently played tracks`;
    case "mcp__spotify__spotify_search":
      return `🔍 Searched Spotify for "${t.input.query ?? ""}"`;
    case "mcp__spotify__spotify_playback_control":
      return `🎵 ${t.input.action === "play" ? "▶️ Resumed" : t.input.action === "pause" ? "⏸️ Paused" : t.input.action === "next" ? "⏭️ Skipped" : "⏮️ Previous"} playback`;
    case "mcp__spotify__spotify_queue":
      return t.input.uri ? `🎵 Added track to queue` : `🎵 Got playback queue`;
    case "mcp__spotify__spotify_top_items":
      return `🎵 Got top ${t.input.type ?? "items"}`;
    case "mcp__spotify__spotify_playlists":
      return `🎵 Listed playlists`;
    case "mcp__spotify__spotify_manage_playlist":
      return `🎵 ${t.input.action === "create" ? "Created playlist" : "Added tracks to playlist"}`;
    default: {
      if (t.name.startsWith("mcp__notion__")) {
        return `📓 Used Notion`;
      }
      return `🔧 Used ${t.name}`;
    }
  }
}

function formatToolSummary(tools: ToolAction[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of tools) {
    const line = formatToolLine(t);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join("\n");
}

// ── Ask Claude ───────────────────────────────────────────────────────────────

async function askClaude(
  prompt: string,
  onToolCall?: (tool: ToolAction) => void
): Promise<{ parts: string[]; tools: ToolAction[] }> {
  const parts: string[] = [];
  const tools: ToolAction[] = [];
  const seenToolIds = new Set<string>();

  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      cwd: process.cwd(),
      settingSources: ["project"],
      allowedTools: [
        "Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep",
        "mcp__search__web_search",
        ...WHATSAPP_TOOL_NAMES,
        ...PRODUCTIVITY_TOOL_NAMES,
        ...MEDIA_TOOL_NAMES,
        ...INFO_TOOL_NAMES,
        ...SOCIAL_TOOL_NAMES,
        ...GMAIL_TOOL_NAMES,
        ...SPOTIFY_TOOL_NAMES,
        ...(notionMcpServer ? NOTION_TOOL_NAMES : []),
      ],
      maxTurns: 10,
      mcpServers: {
        search: searchServer,
        whatsapp: whatsappMcpServer,
        productivity: productivityMcpServer,
        media: mediaMcpServer,
        info: infoMcpServer,
        social: socialMcpServer,
        gmail: gmailMcpServer,
        spotify: spotifyMcpServer,
        ...(notionMcpServer ? { notion: notionMcpServer } : {}),
      },
      includePartialMessages: true,
    },
  })) {
    if (msg.type === "assistant") {
      const content = (msg as any).message.content;
      for (const block of content) {
        if (block.type === "tool_use" && !seenToolIds.has(block.id)) {
          seenToolIds.add(block.id);
          const action: ToolAction = { name: block.name, input: block.input ?? {} };
          tools.push(action);
          onToolCall?.(action);
        }
      }
      const text = content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("");
      if (text.trim()) parts.push(text);
    }
  }

  return { parts, tools };
}

// ── Send helpers ─────────────────────────────────────────────────────────────

async function sendPart(
  ctx: { reply: Function },
  text: string,
  extra: Record<string, unknown> = {}
): Promise<number | undefined> {
  try {
    const sent = await ctx.reply(text, { parse_mode: "Markdown", ...extra });
    return sent?.message_id;
  } catch {
    const sent = await ctx.reply(text, extra);
    return sent?.message_id;
  }
}

// ── Handle message + auto-compaction helper ─────────────────────────────────

async function handleUserMessage(
  chatId: number,
  senderName: string,
  userContent: string,
  telegramMessageId: number,
  replyFn: (text: string, extra?: Record<string, unknown>) => Promise<number | undefined>,
  typingFn: (fn: () => Promise<void>) => Promise<void>
) {
  store.addMessage(chatId, "user", userContent, telegramMessageId);
  store.trackTelegramMessage(chatId, telegramMessageId);

  const { prompt } = contextBuilder.buildContext(chatId, senderName);

  const sentToolLines = new Set<string>();
  const onToolCall = async (tool: ToolAction) => {
    // Confirmable tools show an inline keyboard instead of emoji summary
    const mcpName = tool.name;
    if (CONFIRMABLE_TOOLS.has(mcpName)) return;
    const line = formatToolLine(tool);
    if (sentToolLines.has(line)) return;
    sentToolLines.add(line);
    const sentId = await replyFn(line);
    if (sentId) store.trackTelegramMessage(chatId, sentId);
  };

  let parts: string[] = [];
  let tools: ToolAction[] = [];
  await typingFn(async () => {
    ({ parts, tools } = await chatContext.run(chatId, () => askClaude(prompt, onToolCall)));
  });

  if (parts.length > 0) {
    const fullResponse = parts.join("\n\n");
    store.addMessage(chatId, "assistant", fullResponse);

    for (let i = 0; i < parts.length; i++) {
      const extra: Record<string, unknown> =
        i === 0 ? { reply_parameters: { message_id: telegramMessageId } } : {};
      const sentId = await replyFn(parts[i], extra);
      if (sentId) store.trackTelegramMessage(chatId, sentId);
    }

    const preview = parts[0].substring(0, 80);
    log.info({ chatId, parts: parts.length, tools: tools.length, preview }, "Response sent");

    // Auto-compaction check
    if (contextBuilder.shouldCompact(chatId)) {
      log.info({ chatId }, "Auto-compaction triggered");
      const result = await contextBuilder.compact(chatId);
      if (result) {
        log.info({ chatId, before: result.before, after: result.after }, "Auto-compaction done");
      }
    }
  }
}

// ── Bot setup ────────────────────────────────────────────────────────────────

const bot = new Telegraf(BOT_TOKEN);
setTelegramApi(bot.telegram);

bot.command("start", (ctx) => {
  ctx.reply(
    `Hey! I'm ${BOT_NAME}. Send me a message and I'll respond.\n\n` +
    `Here's what I can do:\n` +
    `💬 WhatsApp — read messages, list chats, send messages\n` +
    `🔍 Web search — find current information\n` +
    `⏰ Reminders — set, list, and manage reminders\n` +
    `📝 Notes — save and search personal notes\n` +
    `🌤️ Weather — get forecasts for any location\n` +
    `📰 News — headlines from BBC, Reuters, TechCrunch, and more\n` +
    `📖 Dictionary — word definitions and pronunciation\n` +
    `🌐 Translation — translate between languages\n` +
    `📚 Wikipedia — search and summarize articles\n` +
    `👁️ OCR — extract text from photos (just send an image!)\n` +
    `🔊 TTS — convert text to voice messages\n` +
    `📜 Transcripts — summarize YouTube videos\n` +
    `📊 Polls — create interactive polls\n` +
    `📧 Gmail — read, search, send, and manage emails\n` +
    `🎵 Spotify — control playback, search music, manage playlists\n` +
    `📓 Notion — search, create, and manage pages and databases\n` +
    `💬 Quotes & 🧠 Facts — random inspiration and knowledge`
  );
});

bot.command("reset", (ctx) => {
  const chatId = ctx.chat.id;
  store.clearChat(chatId);
  ctx.reply("Conversation cleared. Fresh start!");
  log.info({ chatId }, "Conversation reset");
});

bot.command("clear", async (ctx) => {
  const chatId = ctx.chat.id;
  const messageIds = store.getTrackedTelegramMessages(chatId);

  // Include the /clear command message itself
  messageIds.push(ctx.message.message_id);

  let deleted = 0;
  // Telegram allows deleting up to 100 messages per batch
  const BATCH_SIZE = 100;
  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    try {
      await ctx.deleteMessages(batch);
      deleted += batch.length;
    } catch {
      // Fallback: delete one-by-one (some may be >48h old or already deleted)
      for (const msgId of batch) {
        try {
          await ctx.telegram.deleteMessage(chatId, msgId);
          deleted++;
        } catch {
          // Message may be too old or already deleted
        }
      }
    }
  }

  store.clearChat(chatId);
  log.info({ chatId, deleted, total: messageIds.length }, "Conversation cleared");
});

bot.command("status", async (ctx) => {
  const chatId = ctx.chat.id;
  const status = contextBuilder.getStatus(chatId);

  const utilPct = (status.utilization * 100).toFixed(1);
  let ageStr = "n/a";
  if (status.oldestMessageAge !== null) {
    const mins = Math.floor(status.oldestMessageAge / 60_000);
    if (mins < 60) ageStr = `${mins}m`;
    else if (mins < 1440) ageStr = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    else ageStr = `${Math.floor(mins / 1440)}d`;
  }

  const lines = [
    `*Conversation Status*`,
    `Messages: ${status.messageCount}`,
    `Tokens: ~${status.totalTokens.toLocaleString()} / ${MAX_CONTEXT_TOKENS.toLocaleString()}`,
    `Utilization: ${utilPct}%`,
    `Summary: ${status.hasSummary ? "yes" : "no"}`,
    `Oldest message: ${ageStr}`,
  ];

  await sendPart(ctx, lines.join("\n"));
});

bot.command("compact", async (ctx) => {
  const chatId = ctx.chat.id;
  const beforeStatus = contextBuilder.getStatus(chatId);

  if (beforeStatus.messageCount === 0) {
    await ctx.reply("Nothing to compact — conversation is empty.");
    return;
  }

  await ctx.reply("Compacting conversation...");
  const result = await contextBuilder.compact(chatId);

  if (!result) {
    await ctx.reply("Not enough messages to compact (need more than the protected message count).");
    return;
  }

  const afterStatus = contextBuilder.getStatus(chatId);
  const saved = result.before - result.after;
  await sendPart(
    ctx,
    `*Compaction complete*\nBefore: ~${result.before.toLocaleString()} tokens\nAfter: ~${result.after.toLocaleString()} tokens\nSaved: ~${saved.toLocaleString()} tokens\nMessages: ${afterStatus.messageCount} active`
  );

  log.info({ chatId, before: result.before, after: result.after }, "Manual compaction");
});

bot.command("ping", (ctx) => {
  ctx.reply("pong");
});

// ── Inline keyboard confirmation handler ─────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string | undefined;
  if (!data?.startsWith("confirm:")) return;

  const parts = data.split(":");
  if (parts.length !== 3) return;

  const [, id, choice] = parts;
  const approved = choice === "yes";

  const resolved = resolveConfirmation(id, approved);
  if (resolved) {
    await ctx.answerCbQuery(approved ? "Approved" : "Denied");
  } else {
    await ctx.answerCbQuery("Already handled or expired.");
  }
});

// ── Photo handler (OCR) ─────────────────────────────────────────────────────

bot.on(message("photo"), async (ctx) => {
  if (OWNER_CHAT_ID && ctx.from.id !== OWNER_CHAT_ID) return;

  const chatId = ctx.chat.id;
  const senderName = ctx.from.first_name || ctx.from.username || "User";
  const caption = ctx.message.caption ?? "";

  log.info({ chatId, sender: senderName, caption }, "Incoming photo");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const file = await ctx.telegram.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/` + file.file_path;

    // Download photo to temp file
    const tmpPath = join(tmpdir(), `kairo-ocr-${Date.now()}.jpg`);
    const res = await fetch(fileUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(tmpPath, buffer);

    // Run OCR
    let ocrText = "";
    try {
      const { execSync } = await import("node:child_process");
      ocrText = execSync(`tesseract "${tmpPath}" stdout`, { encoding: "utf-8", timeout: 30_000 }).trim();
    } catch {
      ocrText = "(OCR failed or no text detected)";
    }

    // Clean up temp file
    try { unlinkSync(tmpPath); } catch {}

    // Build prompt with OCR context
    const userMessage = caption
      ? `[User sent a photo with caption: "${caption}"]\n[OCR text from image: ${ocrText || "none detected"}]`
      : `[User sent a photo]\n[OCR text from image: ${ocrText || "none detected"}]`;

    await handleUserMessage(
      chatId,
      senderName,
      userMessage,
      ctx.message.message_id,
      (text, extra) => sendPart(ctx, text, extra),
      (fn) => ctx.persistentChatAction("typing", fn)
    );
  } catch (err) {
    log.error({ chatId, err }, "Error handling photo");
    await ctx.reply("Sorry, I couldn't process that photo. Try again in a moment.");
  }
});

// ── Message handler ──────────────────────────────────────────────────────────

bot.on(message("text"), async (ctx) => {
  // Only allow the owner to interact
  if (OWNER_CHAT_ID && ctx.from.id !== OWNER_CHAT_ID) return;

  const chatType = ctx.chat.type;
  const isGroup = chatType === "group" || chatType === "supergroup";

  // In groups, only respond when mentioned or replied to
  if (isGroup) {
    if (!ENABLE_GROUPS) return;

    const botUsername = ctx.botInfo.username;
    const isMentioned = ctx.message.text.includes(`@${botUsername}`);
    const isReply =
      ctx.message.reply_to_message?.from?.id === ctx.botInfo.id;

    if (!isMentioned && !isReply) return;
  }

  const chatId = ctx.chat.id;
  const senderName =
    ctx.from.first_name || ctx.from.username || "User";
  const text = ctx.message.text.replace(/@\w+/g, "").trim();

  if (!text) return;

  if (hasPendingConfirmation(chatId)) {
    await sendPart(ctx, "⏳ Please respond to the pending confirmation buttons first.");
    return;
  }

  log.info({ chatId, sender: senderName, text }, "Incoming message");

  try {
    await handleUserMessage(
      chatId,
      senderName,
      text,
      ctx.message.message_id,
      (text, extra) => sendPart(ctx, text, extra),
      (fn) => ctx.persistentChatAction("typing", fn)
    );
  } catch (err) {
    log.error({ chatId, err }, "Error handling message");
    await ctx.reply("Sorry, something went wrong. Try again in a moment.");
  }
});

// ── Launch ───────────────────────────────────────────────────────────────────

async function main() {
  initDatabase();

  // Check zele is available for Gmail
  try {
    ensureZele();
    log.info("zele CLI ready for Gmail integration");
  } catch (err) {
    log.warn({ err }, "zele not found — install with: npm install -g zele");
  }

  // WhatsApp is optional — don't block startup if it fails
  connectWhatsApp()
    .then(() => log.info("WhatsApp connected"))
    .catch((err) => log.warn({ err }, "WhatsApp unavailable — bot will run without it"));

  startReminderScheduler();

  bot.launch();
  log.info(`${BOT_NAME} is live on Telegram`);
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
