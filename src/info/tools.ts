import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import logger from "../logger";

const log = logger.child({ module: "info" });

// ── Weather ─────────────────────────────────────────────────────────────────

const getWeather = tool(
  "get_weather",
  "Get current weather and forecast for a location. Returns temperature, conditions, wind, humidity, and 3-day forecast.",
  {
    location: z.string().describe("City name or location (e.g. 'Tokyo', 'New York', 'London')"),
  },
  async ({ location }) => {
    log.info({ tool: "get_weather", location }, "Tool invoked");
    try {
      const encoded = encodeURIComponent(location);
      const res = await fetch(`https://wttr.in/${encoded}?format=j1`);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Weather API error: ${res.status} ${res.statusText}` }], isError: true };
      }

      const data = await res.json() as any;
      const current = data.current_condition?.[0];
      if (!current) {
        return { content: [{ type: "text" as const, text: `No weather data found for "${location}".` }] };
      }

      const lines = [
        `Weather for ${data.nearest_area?.[0]?.areaName?.[0]?.value ?? location}:`,
        `🌡️ Temperature: ${current.temp_C}°C (${current.temp_F}°F)`,
        `🤔 Feels like: ${current.FeelsLikeC}°C (${current.FeelsLikeF}°F)`,
        `☁️ Conditions: ${current.weatherDesc?.[0]?.value ?? "Unknown"}`,
        `💨 Wind: ${current.windspeedKmph} km/h ${current.winddir16Point}`,
        `💧 Humidity: ${current.humidity}%`,
        `👁️ Visibility: ${current.visibility} km`,
      ];

      if (data.weather?.length) {
        lines.push("", "Forecast:");
        for (const day of data.weather.slice(0, 3)) {
          const desc = day.hourly?.[4]?.weatherDesc?.[0]?.value ?? "";
          lines.push(`  ${day.date}: ${day.mintempC}–${day.maxtempC}°C, ${desc}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, location }, "Weather fetch failed");
      return { content: [{ type: "text" as const, text: `Weather fetch failed: ${msg}` }], isError: true };
    }
  }
);

// ── News ────────────────────────────────────────────────────────────────────

const RSS_FEEDS: Record<string, string> = {
  bbc: "https://feeds.bbci.co.uk/news/rss.xml",
  reuters: "https://www.rss-bridge.org/bridge01/?action=display&bridge=Reuters&feed=home&format=Mrss",
  techcrunch: "https://techcrunch.com/feed/",
  hackernews: "https://hnrss.org/frontpage",
  aljazeera: "https://www.aljazeera.com/xml/rss/all.xml",
};

const getNews = tool(
  "get_news",
  "Get latest news headlines from major sources. Available sources: bbc, reuters, techcrunch, hackernews, aljazeera.",
  {
    source: z.string().optional().describe("News source (default: bbc). Options: bbc, reuters, techcrunch, hackernews, aljazeera"),
    limit: z.number().min(1).max(20).optional().describe("Number of headlines (default: 10, max: 20)"),
  },
  async ({ source, limit }) => {
    const src = (source ?? "bbc").toLowerCase();
    const max = limit ?? 10;
    log.info({ tool: "get_news", source: src, limit: max }, "Tool invoked");

    const feedUrl = RSS_FEEDS[src];
    if (!feedUrl) {
      return { content: [{ type: "text" as const, text: `Unknown source: "${src}". Available: ${Object.keys(RSS_FEEDS).join(", ")}` }], isError: true };
    }

    try {
      const res = await fetch(feedUrl);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Failed to fetch ${src} feed: ${res.status}` }], isError: true };
      }

      const xml = await res.text();
      const items: { title: string; link: string; date?: string }[] = [];

      // Simple XML parsing with regex
      const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
      let match: RegExpExecArray | null;
      while ((match = itemRegex.exec(xml)) !== null && items.length < max) {
        const block = match[1];
        const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
        const link = block.match(/<link[^>]*>(.*?)<\/link>/)?.[1]?.trim();
        const date = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1]?.trim();
        if (title) items.push({ title, link: link ?? "", date });
      }

      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: `No news items found from ${src}.` }] };
      }

      const lines = items.map((item, i) => {
        const parts = [`${i + 1}. ${item.title}`];
        if (item.link) parts.push(`   ${item.link}`);
        if (item.date) parts.push(`   ${item.date}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Latest from ${src.toUpperCase()}:\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, source: src }, "News fetch failed");
      return { content: [{ type: "text" as const, text: `News fetch failed: ${msg}` }], isError: true };
    }
  }
);

// ── Dictionary ──────────────────────────────────────────────────────────────

const defineWord = tool(
  "define_word",
  "Look up the definition, pronunciation, and examples of a word using a free dictionary API.",
  {
    word: z.string().describe("The word to define"),
    language: z.string().optional().describe("Language code (default: en). Supports: en, es, fr, de, it, pt, etc."),
  },
  async ({ word, language }) => {
    const lang = language ?? "en";
    log.info({ tool: "define_word", word, lang }, "Tool invoked");

    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/${lang}/${encodeURIComponent(word)}`);
      if (!res.ok) {
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `No definition found for "${word}" in ${lang}.` }] };
        }
        return { content: [{ type: "text" as const, text: `Dictionary API error: ${res.status}` }], isError: true };
      }

      const entries = await res.json() as any[];
      const entry = entries[0];
      const lines: string[] = [`**${entry.word}**`];

      if (entry.phonetic) lines.push(`Pronunciation: ${entry.phonetic}`);

      for (const meaning of entry.meanings ?? []) {
        lines.push(`\n_${meaning.partOfSpeech}_:`);
        for (const def of (meaning.definitions ?? []).slice(0, 3)) {
          lines.push(`  • ${def.definition}`);
          if (def.example) lines.push(`    Example: "${def.example}"`);
        }
        if (meaning.synonyms?.length) {
          lines.push(`  Synonyms: ${meaning.synonyms.slice(0, 5).join(", ")}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, word }, "Dictionary fetch failed");
      return { content: [{ type: "text" as const, text: `Dictionary lookup failed: ${msg}` }], isError: true };
    }
  }
);

// ── Translation ─────────────────────────────────────────────────────────────

const translateText = tool(
  "translate_text",
  "Translate text between languages using MyMemory API (free, no API key). Supports most common languages.",
  {
    text: z.string().describe("Text to translate"),
    from: z.string().optional().describe("Source language code (default: auto-detect). E.g. 'en', 'es', 'fr'"),
    to: z.string().describe("Target language code. E.g. 'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh'"),
  },
  async ({ text, from, to }) => {
    const srcLang = from ?? "auto";
    log.info({ tool: "translate_text", from: srcLang, to }, "Tool invoked");

    try {
      const langPair = `${srcLang === "auto" ? "" : srcLang}|${to}`;
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
      const res = await fetch(url);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Translation API error: ${res.status}` }], isError: true };
      }

      const data = await res.json() as any;
      const translated = data.responseData?.translatedText;
      if (!translated) {
        return { content: [{ type: "text" as const, text: "Translation failed — no result returned." }], isError: true };
      }

      const match = data.responseData?.match ? `(${Math.round(data.responseData.match * 100)}% confidence)` : "";
      return {
        content: [{ type: "text" as const, text: `Translation ${match}:\n\n"${text}"\n→ "${translated}"` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Translation failed");
      return { content: [{ type: "text" as const, text: `Translation failed: ${msg}` }], isError: true };
    }
  }
);

// ── Wikipedia ───────────────────────────────────────────────────────────────

const wikipediaSearch = tool(
  "wikipedia_search",
  "Search Wikipedia for a topic and get a summary. Returns the article extract and thumbnail if available.",
  {
    query: z.string().describe("Topic to search for on Wikipedia"),
    language: z.string().optional().describe("Wikipedia language (default: en). E.g. 'en', 'es', 'fr', 'de', 'ja'"),
  },
  async ({ query, language }) => {
    const lang = language ?? "en";
    log.info({ tool: "wikipedia_search", query, lang }, "Tool invoked");

    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`);

      if (!res.ok) {
        if (res.status === 404) {
          return { content: [{ type: "text" as const, text: `No Wikipedia article found for "${query}" in ${lang}.` }] };
        }
        return { content: [{ type: "text" as const, text: `Wikipedia API error: ${res.status}` }], isError: true };
      }

      const data = await res.json() as any;
      const lines: string[] = [];

      if (data.title) lines.push(`**${data.title}**`);
      if (data.description) lines.push(`_${data.description}_`);
      lines.push("");
      if (data.extract) lines.push(data.extract);
      if (data.content_urls?.desktop?.page) lines.push(`\nRead more: ${data.content_urls.desktop.page}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, query }, "Wikipedia fetch failed");
      return { content: [{ type: "text" as const, text: `Wikipedia search failed: ${msg}` }], isError: true };
    }
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const INFO_TOOL_NAMES = [
  "mcp__info__get_weather",
  "mcp__info__get_news",
  "mcp__info__define_word",
  "mcp__info__translate_text",
  "mcp__info__wikipedia_search",
];

export const infoMcpServer = createSdkMcpServer({
  name: "info",
  tools: [getWeather, getNews, defineWord, translateText, wikipediaSearch],
});
