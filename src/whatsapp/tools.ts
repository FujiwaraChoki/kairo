import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { getSocket, isConnected, store } from "./client";
import logger from "../logger";

const log = logger.child({ module: "tools" });

const WA_UNAVAILABLE = {
  content: [{ type: "text" as const, text: "WhatsApp is not connected. Delete the auth_info_baileys/ folder and restart the bot to re-pair via QR code." }],
  isError: true,
};

// ── Tool definitions ────────────────────────────────────────────────────────

const listChats = tool(
  "list_whatsapp_chats",
  "List recent WhatsApp chats with names, unread counts, and last message preview. Use this to see what conversations are available.",
  {
    limit: z
      .number()
      .optional()
      .describe("Max number of chats to return (default 20)"),
  },
  async ({ limit }) => {
    log.info({ tool: "list_whatsapp_chats", limit }, "Tool invoked");
    if (!isConnected()) return WA_UNAVAILABLE;
    const chats = store.getRecentChats(limit ?? 20);
    if (chats.length === 0) {
      log.debug({ tool: "list_whatsapp_chats", resultCount: 0 }, "Tool completed");
      return {
        content: [
          {
            type: "text" as const,
            text: "No chats found yet. The chat list populates after WhatsApp syncs history.",
          },
        ],
      };
    }

    const lines = chats.map((c) => {
      const unread = c.unreadCount > 0 ? ` (${c.unreadCount} unread)` : "";
      const preview = c.lastMessage
        ? ` — ${c.lastMessage.substring(0, 60)}`
        : "";
      return `• ${c.name}${unread}${preview}\n  JID: ${c.jid}`;
    });

    log.debug({ tool: "list_whatsapp_chats", resultCount: chats.length }, "Tool completed");
    return {
      content: [{ type: "text" as const, text: lines.join("\n\n") }],
    };
  }
);

const readMessages = tool(
  "read_whatsapp_messages",
  "Read recent messages from a WhatsApp chat. You can specify the contact by name, phone number, or JID.",
  {
    contact: z
      .string()
      .describe(
        "Contact name, phone number, or JID (e.g. '1234567890@s.whatsapp.net')"
      ),
    limit: z
      .number()
      .optional()
      .describe("Max number of messages to return (default 20)"),
  },
  async ({ contact, limit }) => {
    log.info({ tool: "read_whatsapp_messages", contact }, "Tool invoked");
    if (!isConnected()) return WA_UNAVAILABLE;
    const jid = store.resolveJid(contact);
    if (!jid) {
      log.warn({ tool: "read_whatsapp_messages", contact }, "Contact not found");
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find a contact matching "${contact}". Try using list_whatsapp_chats first to see available conversations.`,
          },
        ],
      };
    }

    const messages = store.getMessages(jid, limit ?? 20);
    log.debug({ tool: "read_whatsapp_messages", resultCount: messages.length }, "Tool completed");
    if (messages.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No messages found for ${contact} (${jid}). Messages populate after sync.`,
          },
        ],
      };
    }

    const chatName = store.chats.get(jid)?.name || jid;
    const lines = messages.map((m) => {
      const time = new Date(m.timestamp * 1000).toLocaleString();
      const sender = m.fromMe ? "You" : m.sender;
      return `[${time}] ${sender}: ${m.text}`;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Messages from ${chatName} (${jid}):\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

const sendMessage = tool(
  "send_whatsapp_message",
  "Send a text message to a WhatsApp contact. You can specify the recipient by name, phone number, or JID.",
  {
    contact: z
      .string()
      .describe(
        "Recipient name, phone number, or JID (e.g. '1234567890@s.whatsapp.net')"
      ),
    message: z.string().describe("The text message to send"),
  },
  async ({ contact, message }) => {
    log.info({ tool: "send_whatsapp_message", contact }, "Tool invoked");
    if (!isConnected()) return WA_UNAVAILABLE;
    const jid = store.resolveJid(contact);
    if (!jid) {
      log.warn({ tool: "send_whatsapp_message", contact }, "Contact not found");
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not find a contact matching "${contact}". Try using search_whatsapp_contacts or list_whatsapp_chats first.`,
          },
        ],
      };
    }

    const sock = getSocket()!;
    await sock.sendMessage(jid, { text: message });
    log.info({ tool: "send_whatsapp_message", jid }, "Message sent via WhatsApp");

    const chatName = store.contacts.get(jid)?.name || store.chats.get(jid)?.name || jid;
    return {
      content: [
        {
          type: "text" as const,
          text: `Message sent to ${chatName} (${jid}): "${message}"`,
        },
      ],
    };
  }
);

const searchContacts = tool(
  "search_whatsapp_contacts",
  "Search WhatsApp contacts by name or phone number. Returns matching contacts with their JIDs.",
  {
    query: z.string().describe("Name or phone number to search for"),
  },
  async ({ query }) => {
    log.info({ tool: "search_whatsapp_contacts", query }, "Tool invoked");
    if (!isConnected()) return WA_UNAVAILABLE;
    const results = store.searchContacts(query);
    if (results.length === 0) {
      log.warn({ tool: "search_whatsapp_contacts", query }, "Contact not found");
      return {
        content: [
          {
            type: "text" as const,
            text: `No contacts found matching "${query}".`,
          },
        ],
      };
    }

    const lines = results.slice(0, 20).map((c) => {
      const notify = c.notify ? ` (${c.notify})` : "";
      return `• ${c.name}${notify}\n  JID: ${c.jid}`;
    });

    log.debug({ tool: "search_whatsapp_contacts", resultCount: results.length }, "Tool completed");
    return {
      content: [
        {
          type: "text" as const,
          text: `Contacts matching "${query}":\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const WHATSAPP_TOOL_NAMES = [
  "mcp__whatsapp__list_whatsapp_chats",
  "mcp__whatsapp__read_whatsapp_messages",
  "mcp__whatsapp__send_whatsapp_message",
  "mcp__whatsapp__search_whatsapp_contacts",
];

export const whatsappMcpServer = createSdkMcpServer({
  name: "whatsapp",
  tools: [listChats, readMessages, sendMessage, searchContacts],
});
