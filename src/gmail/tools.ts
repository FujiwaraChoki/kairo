import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { runZele, isLoggedIn } from "./zele";
import logger from "../logger";

const log = logger.child({ module: "gmail" });

const NOT_LOGGED_IN_MSG =
  "Gmail is not connected yet. The user needs to run `zele login` in their terminal " +
  "(at ~/.kairo/zele) to authenticate with Google. Tell the user to do this — " +
  "it will open a browser for OAuth2 consent.";

// ── List emails ─────────────────────────────────────────────────────────────

const listEmails = tool(
  "gmail_list",
  "List recent email threads from Gmail inbox. Returns subject, sender, date, and thread ID for each conversation.",
  {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Number of threads to return (default 10)"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use (if multiple accounts are linked)"),
  },
  async ({ limit, account }) => {
    log.info({ tool: "gmail_list", limit }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", "list"];
      if (limit) args.push("--limit", String(limit));
      if (account) args.push("--account", account);

      const output = runZele(args, 60_000);
      if (!output) {
        return { content: [{ type: "text" as const, text: "No emails found in inbox." }] };
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "gmail_list failed");
      return { content: [{ type: "text" as const, text: `Failed to list emails: ${msg}` }], isError: true };
    }
  }
);

// ── Search emails ───────────────────────────────────────────────────────────

const searchEmails = tool(
  "gmail_search",
  "Search Gmail using Gmail search syntax. Supports operators like from:, to:, subject:, is:unread, has:attachment, after:, before:, newer_than:, label:, etc.",
  {
    query: z
      .string()
      .describe(
        'Gmail search query (e.g. "from:github is:unread newer_than:7d", "subject:invoice has:attachment")'
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 10)"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use"),
  },
  async ({ query, limit, account }) => {
    log.info({ tool: "gmail_search", query }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", "search", query];
      if (limit) args.push("--limit", String(limit));
      if (account) args.push("--account", account);

      const output = runZele(args, 60_000);
      if (!output) {
        return { content: [{ type: "text" as const, text: `No results for: "${query}"` }] };
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, query }, "gmail_search failed");
      return { content: [{ type: "text" as const, text: `Search failed: ${msg}` }], isError: true };
    }
  }
);

// ── Read email thread ───────────────────────────────────────────────────────

const readEmail = tool(
  "gmail_read",
  "Read a full email thread/conversation by its thread ID. Returns all messages in the thread with sender, date, and body.",
  {
    threadId: z
      .string()
      .describe("The thread ID to read (obtained from gmail_list or gmail_search)"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use"),
  },
  async ({ threadId, account }) => {
    log.info({ tool: "gmail_read", threadId }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", "read", threadId];
      if (account) args.push("--account", account);

      const output = runZele(args, 30_000);
      if (!output) {
        return { content: [{ type: "text" as const, text: `Thread ${threadId} not found or empty.` }] };
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, threadId }, "gmail_read failed");
      return { content: [{ type: "text" as const, text: `Failed to read thread: ${msg}` }], isError: true };
    }
  }
);

// ── Send email ──────────────────────────────────────────────────────────────

const sendEmail = tool(
  "gmail_send",
  "Compose and send a new email. Requires recipient, subject, and body.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body text"),
    cc: z
      .string()
      .optional()
      .describe("CC recipients (comma-separated)"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to send from"),
  },
  async ({ to, subject, body, cc, account }) => {
    log.info({ tool: "gmail_send", to, subject }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", "send", "--to", to, "--subject", subject, "--body", body];
      if (cc) args.push("--cc", cc);
      if (account) args.push("--account", account);

      const output = runZele(args, 30_000);
      return { content: [{ type: "text" as const, text: output || `Email sent to ${to}: "${subject}"` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, to, subject }, "gmail_send failed");
      return { content: [{ type: "text" as const, text: `Failed to send email: ${msg}` }], isError: true };
    }
  }
);

// ── Reply to thread ─────────────────────────────────────────────────────────

const replyEmail = tool(
  "gmail_reply",
  "Reply to an existing email thread. Sends a reply within the conversation.",
  {
    threadId: z
      .string()
      .describe("The thread ID to reply to (obtained from gmail_list or gmail_search)"),
    body: z.string().describe("Reply body text"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use"),
  },
  async ({ threadId, body, account }) => {
    log.info({ tool: "gmail_reply", threadId }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", "reply", threadId, "--body", body];
      if (account) args.push("--account", account);

      const output = runZele(args, 30_000);
      return { content: [{ type: "text" as const, text: output || "Reply sent." }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, threadId }, "gmail_reply failed");
      return { content: [{ type: "text" as const, text: `Failed to reply: ${msg}` }], isError: true };
    }
  }
);

// ── Email actions ───────────────────────────────────────────────────────────

const emailAction = tool(
  "gmail_action",
  "Perform an action on an email thread: archive, trash, star, unstar, mark as read, or mark as unread.",
  {
    threadId: z
      .string()
      .describe("The thread ID to act on"),
    action: z
      .enum(["archive", "trash", "star", "unstar", "read", "unread"])
      .describe("Action to perform on the thread"),
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use"),
  },
  async ({ threadId, action, account }) => {
    log.info({ tool: "gmail_action", threadId, action }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["mail", action, threadId];
      if (account) args.push("--account", account);

      const output = runZele(args, 15_000);
      return { content: [{ type: "text" as const, text: output || `Done: ${action} on thread ${threadId}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, threadId, action }, "gmail_action failed");
      return { content: [{ type: "text" as const, text: `Failed to ${action}: ${msg}` }], isError: true };
    }
  }
);

// ── Labels ──────────────────────────────────────────────────────────────────

const listLabels = tool(
  "gmail_labels",
  "List all Gmail labels with message counts.",
  {
    account: z
      .string()
      .optional()
      .describe("Gmail account email to use"),
  },
  async ({ account }) => {
    log.info({ tool: "gmail_labels" }, "Tool invoked");

    if (!isLoggedIn()) {
      return { content: [{ type: "text" as const, text: NOT_LOGGED_IN_MSG }] };
    }

    try {
      const args = ["label", "list"];
      if (account) args.push("--account", account);

      const output = runZele(args, 15_000);
      return { content: [{ type: "text" as const, text: output || "No labels found." }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "gmail_labels failed");
      return { content: [{ type: "text" as const, text: `Failed to list labels: ${msg}` }], isError: true };
    }
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const GMAIL_TOOL_NAMES = [
  "mcp__gmail__gmail_list",
  "mcp__gmail__gmail_search",
  "mcp__gmail__gmail_read",
  "mcp__gmail__gmail_send",
  "mcp__gmail__gmail_reply",
  "mcp__gmail__gmail_action",
  "mcp__gmail__gmail_labels",
];

export const gmailMcpServer = createSdkMcpServer({
  name: "gmail",
  tools: [listEmails, searchEmails, readEmail, sendEmail, replyEmail, emailAction, listLabels],
});
