<p align="center">
  <img src="icon.svg" width="128" height="128" alt="Kairo" />
</p>

<h1 align="center">Kairo</h1>

<p align="center">
  An AI-powered Telegram bot built on the Claude Agent SDK — with integrations for WhatsApp, Gmail, Spotify, Notion, and more.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/fujiwarachoki/kairo?color=blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.6-brightgreen" alt="Node.js" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D9-f69220?logo=pnpm&logoColor=white" alt="pnpm" />
  <img src="https://img.shields.io/badge/Claude-Agent%20SDK-d97706" alt="Claude Agent SDK" />
</p>

---

Kairo isn't a generic chatbot. It has personality (defined in [`SOUL.md`](SOUL.md)), manages long-running conversations with automatic context compaction, and connects to your real tools through MCP servers.

## Features

- **Telegram** — primary chat interface with rich formatting
- **Claude Agent SDK** — powered by Claude with full tool-use support via MCP
- **Conversation memory** — SQLite-backed context with token budgeting, auto-compaction, and message summarization
- **WhatsApp** — read and send messages, list chats (via Baileys)
- **Gmail** — search, read, send, and reply to emails
- **Spotify** — playback control, search, playlists, top tracks
- **Notion** — search pages, create and update content, manage databases
- **Web search** — real-time search via Exa API
- **Productivity** — reminders, notes, scheduling
- **Media** — OCR, YouTube transcripts, text-to-speech
- **Info** — weather, news, dictionary, translation, Wikipedia
- **Customizable personality** — swap out `SOUL.md` to change the bot's entire character

## Quick Start

```bash
git clone https://github.com/fujiwarachoki/kairo.git
cd kairo
./install.sh
```

The install script walks you through everything — dependencies, API keys, and optional integrations.

## Manual Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with your tokens
pnpm start
```

## Configuration

All configuration is done through environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token |
| `BOT_NAME` | No | Bot display name (default: Kairo) |
| `MAX_CONTEXT_TOKENS` | No | Token budget for context (default: 16000) |
| `ENABLE_GROUPS` | No | Respond in group chats (default: false) |
| `EXA_API_KEY` | No | Enables web search |
| `NOTION_TOKEN` | No | Enables Notion integration |
| `SPOTIFY_CLIENT_ID` | No | Enables Spotify integration |

Integrations are optional — the bot works with just a Telegram token. Enable more by adding the relevant API keys.

## Architecture

```
src/
├── index.ts              # Entry point — bot setup and message routing
├── constants.ts          # Config, env vars, system prompt
├── conversation/         # SQLite-backed memory with compaction
├── whatsapp/             # WhatsApp client and MCP tools
├── gmail/                # Gmail MCP tools
├── spotify/              # Spotify OAuth + MCP tools
├── notion/               # Notion MCP server wrapper
├── productivity/         # Reminders, notes, scheduler
├── media/                # OCR, transcripts, TTS
├── info/                 # Weather, news, dictionary, translation
└── social/               # Polls, quotes, facts
```

Each module exports an MCP server that Claude can call as tools. The conversation system tracks message history per chat with automatic summarization when the token budget is exceeded.

## Personality

Kairo's personality is defined in [`SOUL.md`](SOUL.md). You can edit it to change the bot's voice, values, and behavior — or replace it entirely with your own character definition. Set `SYSTEM_PROMPT` in `.env` to override it with a plain string instead.

## License

[MIT](LICENSE)
