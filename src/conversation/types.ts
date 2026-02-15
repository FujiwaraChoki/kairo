export type MessageRole = "user" | "assistant" | "summary";

export interface StoredMessage {
  id: number;
  chat_id: number;
  role: MessageRole;
  content: string;
  telegram_message_id: number | null;
  created_at: number; // unix ms
  token_estimate: number;
  compacted_at: number | null; // null = active, timestamp = absorbed into summary
}

export interface BuiltContext {
  prompt: string;
  totalTokens: number;
  messageCount: number;
  hasSummary: boolean;
}

export interface ContextStatus {
  messageCount: number;
  totalTokens: number;
  utilization: number; // 0-1
  hasSummary: boolean;
  oldestMessageAge: number | null; // ms since oldest active message
}
