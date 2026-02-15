import type { BaileysEventEmitter, WAMessage } from "@whiskeysockets/baileys";
import type { StoredMessage, StoredChat, StoredContact } from "./types";
import logger from "../logger";

const log = logger.child({ module: "store" });

const MAX_MESSAGES_PER_CHAT = 100;

export class WhatsAppStore {
  contacts = new Map<string, StoredContact>();
  chats = new Map<string, StoredChat>();
  messages = new Map<string, StoredMessage[]>(); // jid -> messages

  bind(ev: BaileysEventEmitter) {
    ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      log.info({ chats: chats.length, contacts: contacts.length, messages: messages.length }, "History sync received");
      for (const chat of chats) {
        if (chat.id) {
          this.chats.set(chat.id, {
            jid: chat.id,
            name: chat.name || chat.id,
            unreadCount: chat.unreadCount ?? 0,
            lastMessageTimestamp: Number(chat.conversationTimestamp ?? 0),
          });
        }
      }
      for (const contact of contacts) {
        if (contact.id) {
          this.contacts.set(contact.id, {
            jid: contact.id,
            name: contact.name || contact.notify || contact.id,
            notify: contact.notify ?? undefined,
          });
        }
      }
      for (const msg of messages) {
        this.upsertMessage(msg);
      }
    });

    ev.on("chats.upsert", (newChats) => {
      log.debug({ count: newChats.length }, "Chats upserted");
      for (const chat of newChats) {
        if (!chat.id) continue;
        this.chats.set(chat.id, {
          jid: chat.id,
          name: chat.name || chat.id,
          unreadCount: chat.unreadCount ?? 0,
          lastMessageTimestamp: Number(chat.conversationTimestamp ?? 0),
        });
      }
    });

    ev.on("chats.update", (updates) => {
      for (const update of updates) {
        const existing = this.chats.get(update.id!);
        if (existing) {
          if (update.unreadCount !== undefined && update.unreadCount !== null) {
            existing.unreadCount = update.unreadCount;
          }
          if (update.conversationTimestamp) {
            existing.lastMessageTimestamp = Number(update.conversationTimestamp);
          }
          if (update.name) {
            existing.name = update.name;
          }
        }
      }
    });

    ev.on("contacts.upsert", (newContacts) => {
      log.debug({ count: newContacts.length }, "Contacts upserted");
      for (const contact of newContacts) {
        this.contacts.set(contact.id, {
          jid: contact.id,
          name: contact.name || contact.notify || contact.id,
          notify: contact.notify ?? undefined,
        });
      }
    });

    ev.on("contacts.update", (updates) => {
      for (const update of updates) {
        const existing = this.contacts.get(update.id!);
        if (existing) {
          if (update.notify) existing.notify = update.notify;
          if (update.name) existing.name = update.name;
        }
      }
    });

    ev.on("messages.upsert", ({ messages }) => {
      log.debug({ count: messages.length }, "Messages upserted");
      for (const msg of messages) {
        this.upsertMessage(msg);
      }
    });
  }

  private upsertMessage(msg: WAMessage) {
    const jid = msg.key?.remoteJid;
    if (!jid || !msg.key?.id) return;

    const text = extractText(msg);
    if (!text) return;

    const stored: StoredMessage = {
      id: msg.key.id,
      jid,
      fromMe: msg.key.fromMe ?? false,
      sender: msg.key.fromMe
        ? "me"
        : msg.pushName || msg.key.participant || jid,
      text,
      timestamp: Number(msg.messageTimestamp ?? Date.now() / 1000),
    };

    if (!this.messages.has(jid)) this.messages.set(jid, []);
    const arr = this.messages.get(jid)!;

    // Avoid duplicates
    const idx = arr.findIndex((m) => m.id === stored.id);
    if (idx >= 0) {
      arr[idx] = stored;
    } else {
      arr.push(stored);
      if (arr.length > MAX_MESSAGES_PER_CHAT) arr.shift();
    }

    // Update chat's last message
    const chat = this.chats.get(jid);
    if (chat) {
      chat.lastMessage = text;
      chat.lastMessageTimestamp = stored.timestamp;
    }
  }

  getRecentChats(limit = 20): StoredChat[] {
    return [...this.chats.values()]
      .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp)
      .slice(0, limit);
  }

  getMessages(jid: string, limit = 20): StoredMessage[] {
    const msgs = this.messages.get(jid) ?? [];
    return msgs.slice(-limit);
  }

  searchContacts(query: string): StoredContact[] {
    const q = query.toLowerCase();
    return [...this.contacts.values()].filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.notify && c.notify.toLowerCase().includes(q)) ||
        c.jid.includes(q)
    );
  }

  /** Resolve a name/number to a JID. Returns the first match or null. */
  resolveJid(nameOrNumber: string): string | null {
    const q = nameOrNumber.toLowerCase().replace(/[^a-z0-9]/g, "");

    // Direct JID
    if (nameOrNumber.includes("@")) return nameOrNumber;

    // Search contacts
    for (const c of this.contacts.values()) {
      const cName = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const cNotify = (c.notify || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cName.includes(q) || cNotify.includes(q) || c.jid.includes(q)) {
        return c.jid;
      }
    }

    // Search chat names
    for (const ch of this.chats.values()) {
      const chName = ch.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (chName.includes(q) || ch.jid.includes(q)) {
        return ch.jid;
      }
    }

    // If it looks like a phone number, format as JID
    const digits = nameOrNumber.replace(/\D/g, "");
    if (digits.length >= 7) return `${digits}@s.whatsapp.net`;

    return null;
  }
}

function extractText(msg: WAMessage): string | undefined {
  const m = msg.message;
  if (!m) return undefined;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    (m.contactMessage ? `[Contact: ${m.contactMessage.displayName}]` : undefined) ||
    (m.locationMessage ? `[Location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]` : undefined) ||
    (m.stickerMessage ? "[Sticker]" : undefined) ||
    (m.audioMessage ? "[Audio]" : undefined) ||
    (m.imageMessage ? "[Image]" : undefined) ||
    (m.videoMessage ? "[Video]" : undefined) ||
    (m.documentMessage ? `[Document: ${m.documentMessage.fileName}]` : undefined)
  );
}
