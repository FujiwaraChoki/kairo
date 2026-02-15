# Conversation Management

Kairo uses a multi-layer conversation system that persists messages in SQLite, builds prompts within a token budget, and automatically compacts old messages into summaries via Claude.

## Architecture

```
src/conversation/
├── types.ts    — StoredMessage, BuiltContext, ContextStatus, MessageRole
├── db.ts       — SQLite init, WAL mode, numbered migrations
├── store.ts    — ConversationStore (CRUD, token estimation, tracking)
├── context.ts  — ContextBuilder (prompt assembly, compaction)
└── index.ts    — barrel re-exports
```

## Storage

All messages are stored in `data/kairo.db` (SQLite, WAL mode) across two tables:

**`messages`** — every user message, assistant response, and compaction summary:

| Column | Purpose |
|---|---|
| `chat_id` | Telegram chat the message belongs to |
| `role` | `user`, `assistant`, or `summary` |
| `content` | The message text |
| `telegram_message_id` | Links back to the Telegram message (nullable) |
| `token_estimate` | Pre-computed at insert time |
| `compacted_at` | `NULL` = active message, timestamp = absorbed into a summary |

**`tracked_telegram_messages`** — Telegram message IDs sent by the bot, used by `/clear` to delete them from the chat.

Schema versioning is handled by a `schema_version` table with numbered migrations in `db.ts`.

## Token Estimation

```
tokens ≈ ceil(characters / 3.5)
```

Computed once when a message is inserted and stored in `token_estimate`. This avoids re-counting on every prompt build. The 3.5 divisor is a rough approximation of Claude's tokenizer for mixed English text.

## Context Building

`ContextBuilder.buildContext(chatId, senderName)` assembles the prompt sent to Claude:

```
[Context: chatId=123, user="Alice"]        ← metadata line
[Conversation summary: ...]               ← if a summary exists
Previous messages:                         ← older messages (newest-first fill)
  Alice: ...
  Kairo: ...

Alice: latest message                      ← most recent message
```

The builder works backward from the newest message, adding messages until the token budget (`MAX_CONTEXT_TOKENS`, default 16,000) is exhausted. This means recent messages are always included, and older ones are dropped gracefully — no hard message-count cutoff.

## Compaction

When active tokens exceed 75% of `MAX_CONTEXT_TOKENS`, compaction runs automatically after a response is sent:

1. The last `PROTECTED_MESSAGES` (default 6) messages are shielded
2. All older messages + any existing summary are gathered
3. Claude is called (single turn, no tools) to produce a concise summary
4. The summary is stored as a `role: "summary"` message
5. Old messages are marked with a `compacted_at` timestamp — kept in DB for audit but excluded from context

Compaction is **rolling**: each new summary incorporates the previous one, then marks it compacted. There is always at most one active summary per chat.

Manual compaction is available via `/compact`.

## Commands

| Command | Behavior |
|---|---|
| `/status` | Shows message count, token estimate, utilization %, summary presence, oldest message age |
| `/compact` | Manually triggers compaction, reports before/after token counts |
| `/reset` | Clears all DB records for the chat (messages + tracked IDs) |
| `/clear` | Deletes tracked Telegram messages from the chat, then clears DB records |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MAX_CONTEXT_TOKENS` | `16000` | Token budget for prompt assembly |
| `PROTECTED_MESSAGES` | `6` | Messages shielded from compaction |
| `DB_PATH` | `data/kairo.db` | SQLite database path |

## Future Improvements

### Per-chat token budgets
Allow power users or group chats to have different token limits. Could be stored in a `chat_settings` table keyed by `chat_id`.

### Smarter token counting
Replace the `chars / 3.5` heuristic with actual tokenizer counts (e.g. `@anthropic-ai/tokenizer` or tiktoken). The current estimate drifts for code-heavy or non-Latin conversations.

### Tiered compaction
Instead of a single summary, maintain multiple layers — e.g. a "session summary" (last few hours) and a "long-term memory" (persistent facts about the user). The long-term layer would survive `/reset`.

### Embedding-based retrieval
For very long conversations, store embeddings of each message chunk and retrieve only the most relevant ones for the current query, rather than relying solely on recency.

### Compaction quality scoring
After compaction, estimate the information loss by checking whether the summary can answer questions the original messages could. If quality drops below a threshold, keep more messages or produce a longer summary.

### Scheduled background compaction
Run compaction on a timer rather than inline after responses, to avoid adding latency to the user-facing reply path.

### Multi-user context in groups
Track per-user facts separately within group chats, so the summary captures who said what and individual preferences are preserved.

### Export / import
Let users export their conversation history (including summaries) as JSON, and import it into a new chat or after a database reset.
