import { getDatabase } from "./db";
import type { StoredMessage, MessageRole } from "./types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

export class ConversationStore {
  addMessage(
    chatId: number,
    role: MessageRole,
    content: string,
    telegramMessageId?: number
  ): StoredMessage {
    const db = getDatabase();
    const now = Date.now();
    const tokenEstimate = estimateTokens(content);

    const result = db
      .prepare(
        `INSERT INTO messages (chat_id, role, content, telegram_message_id, created_at, token_estimate, compacted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(chatId, role, content, telegramMessageId ?? null, now, tokenEstimate);

    return {
      id: result.lastInsertRowid as number,
      chat_id: chatId,
      role,
      content,
      telegram_message_id: telegramMessageId ?? null,
      created_at: now,
      token_estimate: tokenEstimate,
      compacted_at: null,
    };
  }

  getActiveMessages(chatId: number): StoredMessage[] {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND compacted_at IS NULL
         ORDER BY created_at ASC`
      )
      .all(chatId) as StoredMessage[];
  }

  getActiveSummary(chatId: number): StoredMessage | undefined {
    const db = getDatabase();
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE chat_id = ? AND role = 'summary' AND compacted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(chatId) as StoredMessage | undefined;
  }

  getActiveTokenCount(chatId: number): number {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(token_estimate), 0) AS total
         FROM messages
         WHERE chat_id = ? AND compacted_at IS NULL`
      )
      .get(chatId) as { total: number };
    return row.total;
  }

  getActiveMessageCount(chatId: number): number {
    const db = getDatabase();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE chat_id = ? AND compacted_at IS NULL`
      )
      .get(chatId) as { count: number };
    return row.count;
  }

  markCompacted(messageIds: number[]): void {
    if (messageIds.length === 0) return;
    const db = getDatabase();
    const now = Date.now();
    const placeholders = messageIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE messages SET compacted_at = ? WHERE id IN (${placeholders})`
    ).run(now, ...messageIds);
  }

  clearChat(chatId: number): void {
    const db = getDatabase();
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    db.prepare("DELETE FROM tracked_telegram_messages WHERE chat_id = ?").run(chatId);
  }

  // ── Tracked Telegram messages (for /clear) ──

  trackTelegramMessage(chatId: number, telegramMessageId: number): void {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO tracked_telegram_messages (chat_id, telegram_message_id, created_at)
       VALUES (?, ?, ?)`
    ).run(chatId, telegramMessageId, Date.now());
  }

  getTrackedTelegramMessages(chatId: number): number[] {
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT telegram_message_id FROM tracked_telegram_messages WHERE chat_id = ?`
      )
      .all(chatId) as { telegram_message_id: number }[];
    return rows.map((r) => r.telegram_message_id);
  }

  clearTrackedTelegramMessages(chatId: number): void {
    const db = getDatabase();
    db.prepare("DELETE FROM tracked_telegram_messages WHERE chat_id = ?").run(chatId);
  }
}
