import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeJson } from "../store";
import { DATA_DIR } from "../constants";
import type { Reminder, Note } from "./types";
import logger from "../logger";

const log = logger.child({ module: "productivity" });
const REMINDERS_PATH = resolve(DATA_DIR, "reminders.json");
const NOTES_PATH = resolve(DATA_DIR, "notes.json");

// ── Reminder tools ──────────────────────────────────────────────────────────

const setReminder = tool(
  "set_reminder",
  "Set a reminder that will fire at a specific time. The bot will send a Telegram message when the time comes.",
  {
    chatId: z.number().describe("Telegram chat ID to send the reminder to"),
    message: z.string().describe("The reminder message"),
    time: z.string().describe("When to fire the reminder (ISO 8601 format, e.g. '2025-01-15T14:30:00Z')"),
  },
  async ({ chatId, message, time }) => {
    log.info({ tool: "set_reminder", chatId, time }, "Tool invoked");

    const parsed = new Date(time);
    if (isNaN(parsed.getTime())) {
      return { content: [{ type: "text" as const, text: `Invalid time format: "${time}". Use ISO 8601 (e.g. 2025-01-15T14:30:00Z).` }], isError: true };
    }

    if (parsed.getTime() <= Date.now()) {
      return { content: [{ type: "text" as const, text: "The reminder time is in the past. Please set a future time." }], isError: true };
    }

    const reminder: Reminder = {
      id: randomUUID(),
      chatId,
      message,
      time: parsed.toISOString(),
      createdAt: new Date().toISOString(),
      fired: false,
    };

    const reminders = readJson<Reminder[]>(REMINDERS_PATH, []);
    reminders.push(reminder);
    writeJson(REMINDERS_PATH, reminders);

    log.info({ id: reminder.id, time: reminder.time }, "Reminder set");
    return {
      content: [{ type: "text" as const, text: `Reminder set (ID: ${reminder.id}).\nMessage: "${message}"\nTime: ${parsed.toLocaleString()}` }],
    };
  }
);

const listReminders = tool(
  "list_reminders",
  "List pending (unfired) reminders for a chat.",
  {
    chatId: z.number().describe("Telegram chat ID"),
  },
  async ({ chatId }) => {
    log.info({ tool: "list_reminders", chatId }, "Tool invoked");
    const reminders = readJson<Reminder[]>(REMINDERS_PATH, []);
    const pending = reminders.filter((r) => r.chatId === chatId && !r.fired);

    if (pending.length === 0) {
      return { content: [{ type: "text" as const, text: "No pending reminders." }] };
    }

    const lines = pending.map((r) =>
      `• ${r.message}\n  Time: ${new Date(r.time).toLocaleString()}\n  ID: ${r.id}`
    );
    return { content: [{ type: "text" as const, text: `Pending reminders:\n\n${lines.join("\n\n")}` }] };
  }
);

const deleteReminder = tool(
  "delete_reminder",
  "Delete a reminder by its ID.",
  {
    id: z.string().describe("Reminder ID to delete"),
  },
  async ({ id }) => {
    log.info({ tool: "delete_reminder", id }, "Tool invoked");
    const reminders = readJson<Reminder[]>(REMINDERS_PATH, []);
    const idx = reminders.findIndex((r) => r.id === id);

    if (idx === -1) {
      return { content: [{ type: "text" as const, text: `Reminder not found: ${id}` }], isError: true };
    }

    reminders.splice(idx, 1);
    writeJson(REMINDERS_PATH, reminders);
    return { content: [{ type: "text" as const, text: `Reminder deleted: ${id}` }] };
  }
);

// ── Notes tools ─────────────────────────────────────────────────────────────

const saveNote = tool(
  "save_note",
  "Save a note with a title, content, and optional tags.",
  {
    chatId: z.number().describe("Telegram chat ID"),
    title: z.string().describe("Note title"),
    content: z.string().describe("Note content"),
    tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
  },
  async ({ chatId, title, content, tags }) => {
    log.info({ tool: "save_note", chatId, title }, "Tool invoked");

    const note: Note = {
      id: randomUUID(),
      chatId,
      title,
      content,
      tags: tags ?? [],
      createdAt: new Date().toISOString(),
    };

    const notes = readJson<Note[]>(NOTES_PATH, []);
    notes.push(note);
    writeJson(NOTES_PATH, notes);

    log.info({ id: note.id }, "Note saved");
    return {
      content: [{ type: "text" as const, text: `Note saved (ID: ${note.id}).\nTitle: "${title}"${tags?.length ? `\nTags: ${tags.join(", ")}` : ""}` }],
    };
  }
);

const searchNotes = tool(
  "search_notes",
  "Search saved notes by text query or tag.",
  {
    chatId: z.number().describe("Telegram chat ID"),
    query: z.string().optional().describe("Search in title and content"),
    tag: z.string().optional().describe("Filter by tag"),
  },
  async ({ chatId, query, tag }) => {
    log.info({ tool: "search_notes", chatId, query, tag }, "Tool invoked");
    const notes = readJson<Note[]>(NOTES_PATH, []);
    let results = notes.filter((n) => n.chatId === chatId);

    if (tag) {
      const t = tag.toLowerCase();
      results = results.filter((n) => n.tags.some((nt) => nt.toLowerCase() === t));
    }
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(
        (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
      );
    }

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No notes found matching your search." }] };
    }

    const lines = results.map((n) => {
      const tagStr = n.tags.length ? ` [${n.tags.join(", ")}]` : "";
      const preview = n.content.length > 80 ? n.content.slice(0, 80) + "…" : n.content;
      return `• ${n.title}${tagStr}\n  ${preview}\n  ID: ${n.id}`;
    });
    return { content: [{ type: "text" as const, text: `Notes:\n\n${lines.join("\n\n")}` }] };
  }
);

const deleteNote = tool(
  "delete_note",
  "Delete a note by its ID.",
  {
    id: z.string().describe("Note ID to delete"),
  },
  async ({ id }) => {
    log.info({ tool: "delete_note", id }, "Tool invoked");
    const notes = readJson<Note[]>(NOTES_PATH, []);
    const idx = notes.findIndex((n) => n.id === id);

    if (idx === -1) {
      return { content: [{ type: "text" as const, text: `Note not found: ${id}` }], isError: true };
    }

    notes.splice(idx, 1);
    writeJson(NOTES_PATH, notes);
    return { content: [{ type: "text" as const, text: `Note deleted: ${id}` }] };
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const PRODUCTIVITY_TOOL_NAMES = [
  "mcp__productivity__set_reminder",
  "mcp__productivity__list_reminders",
  "mcp__productivity__delete_reminder",
  "mcp__productivity__save_note",
  "mcp__productivity__search_notes",
  "mcp__productivity__delete_note",
];

export const productivityMcpServer = createSdkMcpServer({
  name: "productivity",
  tools: [setReminder, listReminders, deleteReminder, saveNote, searchNotes, deleteNote],
});
