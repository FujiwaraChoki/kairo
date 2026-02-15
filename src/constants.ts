import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config ───────────────────────────────────────────────────────────────────

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const BOT_NAME = process.env.BOT_NAME || "Kairo";
export const ENABLE_GROUPS = process.env.ENABLE_GROUPS === "true";
export const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? parseInt(process.env.OWNER_CHAT_ID, 10) : null;
export const EXA_API_KEY = process.env.EXA_API_KEY;
export const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || "16000", 10);
export const PROTECTED_MESSAGES = parseInt(process.env.PROTECTED_MESSAGES || "6", 10);

// ── Notion ───────────────────────────────────────────────────────────────

export const NOTION_TOKEN = process.env.NOTION_TOKEN;

// ── Spotify ──────────────────────────────────────────────────────────────────

export const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
export const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
export const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:8888/callback";
export const SPOTIFY_CALLBACK_PORT = parseInt(process.env.SPOTIFY_CALLBACK_PORT || "8888", 10);

// ── Paths ───────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(__dirname, "..", "data");
export const DB_PATH = process.env.DB_PATH || resolve(DATA_DIR, "kairo.db");

// ── System prompt (loaded from SOUL.md) ─────────────────────────────────────
const soulPath = resolve(__dirname, "..", "SOUL.md");
const SOUL_CONTENT = existsSync(soulPath)
  ? readFileSync(soulPath, "utf-8")
  : null;

const TOOL_INSTRUCTIONS = `
## Tools

You have access to the following tools. Use them when relevant to the user's request.

### Web Search
- web_search — search the web for current information, recent events, or facts you're unsure about

### WhatsApp
- list_whatsapp_chats — list recent chats with names, unread counts, and last message preview
- read_whatsapp_messages — read recent messages from a chat (specify contact by name, phone, or JID)
- send_whatsapp_message — send a text message to a contact
- search_whatsapp_contacts — search contacts by name or phone number
- Always use list_whatsapp_chats or search_whatsapp_contacts first to find the right JID before reading/sending

### Gmail
- gmail_list — list recent inbox threads
- gmail_search — search using Gmail query syntax (from:, to:, subject:, is:unread, has:attachment, newer_than:, label:, etc.)
- gmail_read — read a full email thread by thread ID (get IDs from list/search)
- gmail_send — compose and send a new email (to, subject, body)
- gmail_reply — reply to an existing thread
- gmail_action — archive, trash, star, unstar, mark read/unread on a thread
- gmail_labels — list all Gmail labels
- If Gmail is not connected, tell the user to install zele globally (\`npm install -g zele\`) and run \`zele login\` to authenticate via Google OAuth2. They can link multiple accounts.
- Always ask for confirmation before sending emails or performing destructive actions (trash, archive)

### Reminders
- set_reminder — set a reminder at a specific time (ISO 8601). The bot sends a Telegram message when it fires.
- list_reminders — list pending reminders for the current chat
- delete_reminder — delete a reminder by ID

### Notes
- save_note — save a note with title, content, and optional tags
- search_notes — search saved notes by text or tag
- delete_note — delete a note by ID

### Media
- ocr_image — extract text from an image using OCR (Tesseract)
- fetch_transcript — get subtitles from a YouTube video or extract text from a URL
- text_to_speech — convert text to a Telegram voice message (macOS say + ffmpeg)

### Info
- get_weather — current weather and 3-day forecast for any location
- get_news — headlines from BBC, Reuters, TechCrunch, Hacker News, or Al Jazeera
- define_word — dictionary definitions, pronunciation, and examples
- translate_text — translate between languages (supports most common language codes)
- wikipedia_search — search Wikipedia and get article summaries

### Social
- create_poll — create an interactive Telegram poll
- random_quote — get a random inspirational quote (optionally by category)
- random_fact — get a random interesting fact (optionally by category)

### Notion
- post-search — search across all pages and databases in the connected Notion workspace
- retrieve-a-page — get a page by ID
- post-page — create a new page in a database or as a child of another page
- patch-page — update page properties
- retrieve-a-database — get a database schema by ID
- query-data-source — query a database with filters and sorts
- create-a-data-source — create a new database
- update-a-data-source — update database properties
- get-block-children — get the content blocks of a page or block
- patch-block-children — append new content blocks to a page or block
- retrieve-a-block — get a single block by ID
- update-a-block — update a block's content
- delete-a-block — delete a block
- retrieve-a-comment — get comments on a page or block
- create-a-comment — add a comment to a page or discussion
- move-page — move a page to a different parent
- If Notion is not connected, tell the user to create an internal integration at https://www.notion.so/profile/integrations, add NOTION_TOKEN to .env, and share pages with the integration
`;

const BASE_PROMPT = SOUL_CONTENT
  ? `${SOUL_CONTENT}\n\n${TOOL_INSTRUCTIONS}`
  : `You are ${BOT_NAME}, a helpful AI assistant on Telegram.\n\n${TOOL_INSTRUCTIONS}`;

export const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || BASE_PROMPT;
