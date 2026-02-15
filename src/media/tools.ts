import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTelegramApi } from "../telegram";
import logger from "../logger";

const log = logger.child({ module: "media" });

// ── OCR ─────────────────────────────────────────────────────────────────────

const ocrImage = tool(
  "ocr_image",
  "Extract text from an image file using Tesseract OCR. The file must exist on disk.",
  {
    filePath: z.string().describe("Absolute path to the image file"),
  },
  async ({ filePath }) => {
    log.info({ tool: "ocr_image", filePath }, "Tool invoked");

    if (!existsSync(filePath)) {
      return { content: [{ type: "text" as const, text: `File not found: ${filePath}` }], isError: true };
    }

    try {
      const text = execSync(`tesseract "${filePath}" stdout`, {
        encoding: "utf-8",
        timeout: 30_000,
      }).trim();

      if (!text) {
        return { content: [{ type: "text" as const, text: "No text detected in the image." }] };
      }

      return { content: [{ type: "text" as const, text: `OCR result:\n\n${text}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, filePath }, "OCR failed");
      return { content: [{ type: "text" as const, text: `OCR failed: ${msg}` }], isError: true };
    }
  }
);

// ── YouTube/URL transcript ──────────────────────────────────────────────────

const fetchTranscript = tool(
  "fetch_transcript",
  "Fetch subtitles/transcript from a YouTube video, or extract text content from a general URL. For YouTube, uses yt-dlp to get auto-generated subtitles. For other URLs, fetches the page and strips HTML.",
  {
    url: z.string().describe("YouTube video URL or any web page URL"),
  },
  async ({ url }) => {
    log.info({ tool: "fetch_transcript", url }, "Tool invoked");

    const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(url);

    if (isYouTube) {
      return fetchYouTubeTranscript(url);
    }
    return fetchPageContent(url);
  }
);

async function fetchYouTubeTranscript(url: string): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const tmpBase = join(tmpdir(), `kairo-sub-${randomUUID()}`);
  try {
    // Try auto-generated subtitles first
    try {
      execSync(
        `yt-dlp --write-auto-sub --sub-lang en --skip-download --sub-format vtt -o "${tmpBase}" "${url}"`,
        { encoding: "utf-8", timeout: 60_000 }
      );

      const vttPath = `${tmpBase}.en.vtt`;
      if (existsSync(vttPath)) {
        const raw = readFileSync(vttPath, "utf-8");
        // Strip VTT headers and timestamps, keep only text
        const text = raw
          .split("\n")
          .filter((line) => !line.match(/^(WEBVTT|Kind:|Language:|NOTE|\d{2}:\d{2})/))
          .filter((line) => !line.match(/^$/))
          .filter((line) => !line.match(/-->/))
          .map((line) => line.replace(/<[^>]+>/g, "").trim())
          .filter(Boolean)
          .join(" ")
          // Remove duplicate consecutive phrases (common in auto-subs)
          .replace(/(.{20,}?)\1+/g, "$1");

        unlinkSync(vttPath);
        if (text.length > 100) {
          return { content: [{ type: "text" as const, text: `YouTube transcript:\n\n${text.slice(0, 15000)}` }] };
        }
      }
    } catch {
      // Subtitles not available, fall through
    }

    // Fallback: get video description via JSON dump
    try {
      const json = execSync(`yt-dlp --dump-json --no-download "${url}"`, {
        encoding: "utf-8",
        timeout: 30_000,
      });
      const data = JSON.parse(json);
      const parts: string[] = [];
      if (data.title) parts.push(`Title: ${data.title}`);
      if (data.uploader) parts.push(`Channel: ${data.uploader}`);
      if (data.duration_string) parts.push(`Duration: ${data.duration_string}`);
      if (data.description) parts.push(`\nDescription:\n${data.description.slice(0, 5000)}`);

      return { content: [{ type: "text" as const, text: parts.join("\n") || "No transcript or description available." }] };
    } catch {
      return { content: [{ type: "text" as const, text: "Could not extract subtitles or description from this video." }], isError: true };
    }
  } finally {
    // Clean up any remaining temp files
    for (const ext of [".en.vtt", ".en.srt", ".vtt", ".srt"]) {
      try { unlinkSync(`${tmpBase}${ext}`); } catch {}
    }
  }
}

async function fetchPageContent(url: string): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Kairo/1.0)" },
    });
    if (!res.ok) {
      return { content: [{ type: "text" as const, text: `Failed to fetch URL: ${res.status} ${res.statusText}` }], isError: true };
    }

    const html = await res.text();
    // Strip HTML tags and extra whitespace
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) {
      return { content: [{ type: "text" as const, text: "No text content found on the page." }] };
    }

    return { content: [{ type: "text" as const, text: `Page content:\n\n${text.slice(0, 15000)}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, url }, "Page fetch failed");
    return { content: [{ type: "text" as const, text: `Failed to fetch page: ${msg}` }], isError: true };
  }
}

// ── Text to Speech ──────────────────────────────────────────────────────────

const textToSpeech = tool(
  "text_to_speech",
  "Convert text to speech and send as a voice message in Telegram. Uses macOS 'say' command with ffmpeg for encoding.",
  {
    chatId: z.number().describe("Telegram chat ID to send the voice message to"),
    text: z.string().describe("Text to convert to speech"),
    voice: z.string().optional().describe("macOS voice name (default: Samantha). Common: Samantha, Alex, Daniel, Karen, Moira"),
  },
  async ({ chatId, text, voice }) => {
    const voiceName = voice ?? "Samantha";
    log.info({ tool: "text_to_speech", chatId, voiceName, textLength: text.length }, "Tool invoked");

    const id = randomUUID();
    const textPath = join(tmpdir(), `kairo-tts-${id}.txt`);
    const aiffPath = join(tmpdir(), `kairo-tts-${id}.aiff`);
    const oggPath = join(tmpdir(), `kairo-tts-${id}.ogg`);

    try {
      // Write text to file to avoid shell injection
      writeFileSync(textPath, text, "utf-8");

      // Generate speech
      execSync(`say -v "${voiceName}" -f "${textPath}" -o "${aiffPath}"`, {
        timeout: 60_000,
      });

      // Convert to OGG Opus (Telegram voice format)
      execSync(`ffmpeg -y -i "${aiffPath}" -c:a libopus -b:a 64k "${oggPath}"`, {
        timeout: 30_000,
      });

      // Send voice message
      const api = getTelegramApi();
      await api.sendVoice(chatId, { source: readFileSync(oggPath) });

      log.info({ chatId, voiceName }, "TTS voice message sent");
      return { content: [{ type: "text" as const, text: `Voice message sent using "${voiceName}" voice.` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, chatId }, "TTS failed");
      return { content: [{ type: "text" as const, text: `Text-to-speech failed: ${msg}` }], isError: true };
    } finally {
      for (const p of [textPath, aiffPath, oggPath]) {
        try { unlinkSync(p); } catch {}
      }
    }
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const MEDIA_TOOL_NAMES = [
  "mcp__media__ocr_image",
  "mcp__media__fetch_transcript",
  "mcp__media__text_to_speech",
];

export const mediaMcpServer = createSdkMcpServer({
  name: "media",
  tools: [ocrImage, fetchTranscript, textToSpeech],
});
