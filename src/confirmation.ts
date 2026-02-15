import { randomUUID } from "node:crypto";
import { getTelegramApi } from "./telegram";
import { chatContext } from "./context-store";
import logger from "./logger";

const log = logger.child({ module: "confirmation" });

const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  messageId: number;
  chatId: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingConfirmation>();

/** Tools that require inline keyboard confirmation before executing. */
export const CONFIRMABLE_TOOLS = new Set([
  "mcp__gmail__gmail_send",
  "mcp__gmail__gmail_reply",
  "mcp__gmail__gmail_action",
  "mcp__whatsapp__send_whatsapp_message",
]);

/**
 * Send an inline keyboard confirmation to the user and block until they respond.
 * Returns `true` if approved, `false` if denied or timed out.
 */
export async function requestConfirmation(req: {
  tool: string;
  description: string;
}): Promise<boolean> {
  const chatId = chatContext.getStore();
  if (chatId === undefined) {
    log.warn({ tool: req.tool }, "No chat context — skipping confirmation");
    return true;
  }

  const id = randomUUID();
  const telegram = getTelegramApi();

  const sent = await telegram.sendMessage(chatId, `⚠️ *Confirm: ${req.tool}*\n${req.description}`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `confirm:${id}:yes` },
          { text: "❌ Deny", callback_data: `confirm:${id}:no` },
        ],
      ],
    },
  });

  log.info({ chatId, confirmationId: id, tool: req.tool }, "Confirmation requested");

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(async () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      try {
        await telegram.editMessageText(chatId, sent.message_id, undefined, `⚠️ *Confirm: ${req.tool}*\n${req.description}\n\n⏰ _Timed out — auto-denied_`, {
          parse_mode: "Markdown",
        });
      } catch {}
      log.info({ chatId, confirmationId: id }, "Confirmation timed out");
      resolve(false);
    }, TIMEOUT_MS);

    pending.set(id, { resolve, messageId: sent.message_id, chatId, timer });
  });
}

/**
 * Resolve a pending confirmation. Called from the callback_query handler.
 * Returns `true` if the confirmation existed and was resolved.
 */
export function resolveConfirmation(id: string, approved: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(id);

  const telegram = getTelegramApi();
  const statusText = approved ? "✅ _Approved_" : "❌ _Denied_";
  telegram
    .editMessageReplyMarkup(entry.chatId, entry.messageId, undefined, { inline_keyboard: [] })
    .catch(() => {});
  telegram
    .editMessageText(entry.chatId, entry.messageId, undefined, `${statusText}`, {
      parse_mode: "Markdown",
    })
    .catch(() => {});

  log.info({ confirmationId: id, approved }, "Confirmation resolved");
  entry.resolve(approved);
  return true;
}

/** Check if a chat has a pending confirmation waiting for response. */
export function hasPendingConfirmation(chatId: number): boolean {
  for (const entry of pending.values()) {
    if (entry.chatId === chatId) return true;
  }
  return false;
}
