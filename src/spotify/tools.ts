import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from "../constants";
import { isSpotifyConnected, spotifyFetch } from "./client";
import { getAuthUrl, startCallbackServer } from "./auth";
import logger from "../logger";

const log = logger.child({ module: "spotify" });

const NOT_CONNECTED =
  "Spotify is not connected. Ask the user to connect Spotify first using the spotify_auth tool.";

function notConfigured(): string {
  return "Spotify integration is not configured — SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env.";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTrack(t: any): string {
  const artists = t.artists?.map((a: any) => a.name).join(", ") ?? "Unknown";
  const album = t.album?.name ?? "";
  const dur = t.duration_ms
    ? `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, "0")}`
    : "";
  return `${t.name} — ${artists}${album ? ` (${album})` : ""}${dur ? ` [${dur}]` : ""}\nURI: ${t.uri}`;
}

async function handleSpotifyError(res: Response): Promise<string | null> {
  if (res.ok) return null;

  if (res.status === 204) return "Nothing is currently playing.";
  if (res.status === 403) return "This action requires Spotify Premium.";
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? "a few";
    return `Rate limited by Spotify. Try again in ${retryAfter} seconds.`;
  }

  const text = await res.text().catch(() => "");
  return `Spotify API error (${res.status}): ${text}`;
}

// ── Tools ────────────────────────────────────────────────────────────────────

const spotifyAuth = tool(
  "spotify_auth",
  "Generate a Spotify OAuth authorization link so the user can connect their Spotify account. Starts a local callback server to receive the auth code.",
  {},
  async () => {
    log.info({ tool: "spotify_auth" }, "Tool invoked");

    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      return { content: [{ type: "text" as const, text: notConfigured() }], isError: true };
    }

    if (isSpotifyConnected()) {
      return { content: [{ type: "text" as const, text: "Spotify is already connected! You can use all Spotify tools." }] };
    }

    try {
      await startCallbackServer();
      const url = getAuthUrl();
      return {
        content: [{ type: "text" as const, text: `Click this link to connect Spotify:\n\n${url}\n\nAfter authorizing, you'll see a success page. Then all Spotify tools will work.` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Failed to start auth flow");
      return { content: [{ type: "text" as const, text: `Failed to start Spotify auth: ${msg}` }], isError: true };
    }
  }
);

const spotifyNowPlaying = tool(
  "spotify_now_playing",
  "Get the currently playing track or episode on Spotify.",
  {},
  async () => {
    log.info({ tool: "spotify_now_playing" }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      const res = await spotifyFetch("/me/player/currently-playing");
      if (res.status === 204) {
        return { content: [{ type: "text" as const, text: "Nothing is currently playing." }] };
      }

      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();
      if (!data.item) {
        return { content: [{ type: "text" as const, text: "Nothing is currently playing." }] };
      }

      const item = data.item;
      const isPlaying = data.is_playing ? "▶️ Playing" : "⏸️ Paused";
      const progress = data.progress_ms
        ? `${Math.floor(data.progress_ms / 60000)}:${String(Math.floor((data.progress_ms % 60000) / 1000)).padStart(2, "0")}`
        : "0:00";
      const duration = item.duration_ms
        ? `${Math.floor(item.duration_ms / 60000)}:${String(Math.floor((item.duration_ms % 60000) / 1000)).padStart(2, "0")}`
        : "?:??";

      const lines = [
        `${isPlaying}`,
        formatTrack(item),
        `Progress: ${progress} / ${duration}`,
      ];

      if (data.device) lines.push(`Device: ${data.device.name} (${data.device.type})`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Now playing failed");
      return { content: [{ type: "text" as const, text: `Failed to get now playing: ${msg}` }], isError: true };
    }
  }
);

const spotifyRecentlyPlayed = tool(
  "spotify_recently_played",
  "Get recently played tracks on Spotify.",
  {
    limit: z.number().min(1).max(50).optional().describe("Number of tracks to return (default 10, max 50)"),
  },
  async ({ limit }) => {
    log.info({ tool: "spotify_recently_played", limit }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      const res = await spotifyFetch(`/me/player/recently-played?limit=${limit ?? 10}`);
      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();
      if (!data.items?.length) {
        return { content: [{ type: "text" as const, text: "No recently played tracks." }] };
      }

      const lines = data.items.map((item: any, i: number) => {
        const t = item.track;
        const playedAt = new Date(item.played_at).toLocaleString();
        return `${i + 1}. ${formatTrack(t)}\n   Played: ${playedAt}`;
      });

      return { content: [{ type: "text" as const, text: `Recently played:\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Recently played failed");
      return { content: [{ type: "text" as const, text: `Failed to get recently played: ${msg}` }], isError: true };
    }
  }
);

const spotifySearch = tool(
  "spotify_search",
  "Search Spotify for tracks, artists, albums, or playlists.",
  {
    query: z.string().describe("Search query"),
    type: z.enum(["track", "artist", "album", "playlist"]).optional().describe("Type to search for (default: track)"),
    limit: z.number().min(1).max(20).optional().describe("Number of results (default 5, max 20)"),
  },
  async ({ query, type, limit }) => {
    log.info({ tool: "spotify_search", query, type }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      const searchType = type ?? "track";
      const params = new URLSearchParams({ q: query, type: searchType, limit: String(limit ?? 5) });
      const res = await spotifyFetch(`/search?${params}`);
      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();

      const key = `${searchType}s`; // tracks, artists, albums, playlists
      const items = data[key]?.items ?? [];

      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: `No ${searchType}s found for "${query}".` }] };
      }

      let lines: string[];
      switch (searchType) {
        case "track":
          lines = items.map((t: any, i: number) => `${i + 1}. ${formatTrack(t)}`);
          break;
        case "artist":
          lines = items.map((a: any, i: number) =>
            `${i + 1}. ${a.name} — ${a.followers?.total?.toLocaleString() ?? 0} followers\n   Genres: ${a.genres?.join(", ") || "N/A"}\n   URI: ${a.uri}`
          );
          break;
        case "album":
          lines = items.map((a: any, i: number) =>
            `${i + 1}. ${a.name} — ${a.artists?.map((ar: any) => ar.name).join(", ")}\n   Released: ${a.release_date} · ${a.total_tracks} tracks\n   URI: ${a.uri}`
          );
          break;
        case "playlist":
          lines = items.map((p: any, i: number) =>
            `${i + 1}. ${p.name} — by ${p.owner?.display_name ?? "Unknown"}\n   ${p.tracks?.total ?? 0} tracks\n   URI: ${p.uri}`
          );
          break;
        default:
          lines = items.map((item: any, i: number) => `${i + 1}. ${item.name}\n   URI: ${item.uri}`);
      }

      return { content: [{ type: "text" as const, text: `Search results for "${query}" (${searchType}s):\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Search failed");
      return { content: [{ type: "text" as const, text: `Search failed: ${msg}` }], isError: true };
    }
  }
);

const spotifyPlaybackControl = tool(
  "spotify_playback_control",
  "Control Spotify playback: play, pause, next, or previous track. Requires Spotify Premium.",
  {
    action: z.enum(["play", "pause", "next", "previous"]).describe("Playback action"),
  },
  async ({ action }) => {
    log.info({ tool: "spotify_playback_control", action }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      let res: Response;
      switch (action) {
        case "play":
          res = await spotifyFetch("/me/player/play", { method: "PUT" });
          break;
        case "pause":
          res = await spotifyFetch("/me/player/pause", { method: "PUT" });
          break;
        case "next":
          res = await spotifyFetch("/me/player/next", { method: "POST" });
          break;
        case "previous":
          res = await spotifyFetch("/me/player/previous", { method: "POST" });
          break;
      }

      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const labels: Record<string, string> = {
        play: "▶️ Resumed playback",
        pause: "⏸️ Paused playback",
        next: "⏭️ Skipped to next track",
        previous: "⏮️ Went to previous track",
      };

      return { content: [{ type: "text" as const, text: labels[action] }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Playback control failed");
      return { content: [{ type: "text" as const, text: `Playback control failed: ${msg}` }], isError: true };
    }
  }
);

const spotifyQueue = tool(
  "spotify_queue",
  "View the current playback queue, or add a track to the queue by providing its Spotify URI.",
  {
    uri: z.string().optional().describe("Spotify track URI to add to queue (e.g. spotify:track:xxx). If omitted, shows current queue."),
  },
  async ({ uri }) => {
    log.info({ tool: "spotify_queue", uri }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      if (uri) {
        const res = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: "POST" });
        const error = await handleSpotifyError(res);
        if (error) return { content: [{ type: "text" as const, text: error }], isError: true };
        return { content: [{ type: "text" as const, text: `Added to queue: ${uri}` }] };
      }

      // View queue
      const res = await spotifyFetch("/me/player/queue");
      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();
      const lines: string[] = [];

      if (data.currently_playing) {
        lines.push(`Now playing: ${formatTrack(data.currently_playing)}`);
      }

      if (data.queue?.length > 0) {
        lines.push("\nUp next:");
        data.queue.slice(0, 10).forEach((t: any, i: number) => {
          lines.push(`${i + 1}. ${formatTrack(t)}`);
        });
        if (data.queue.length > 10) {
          lines.push(`...and ${data.queue.length - 10} more`);
        }
      } else {
        lines.push("\nQueue is empty.");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Queue operation failed");
      return { content: [{ type: "text" as const, text: `Queue operation failed: ${msg}` }], isError: true };
    }
  }
);

const spotifyTopItems = tool(
  "spotify_top_items",
  "Get the user's top tracks or artists on Spotify.",
  {
    type: z.enum(["tracks", "artists"]).describe("Whether to get top tracks or artists"),
    time_range: z.enum(["short_term", "medium_term", "long_term"]).optional().describe("Time range: short_term (~4 weeks), medium_term (~6 months), long_term (all time). Default: medium_term"),
    limit: z.number().min(1).max(50).optional().describe("Number of items (default 10, max 50)"),
  },
  async ({ type, time_range, limit }) => {
    log.info({ tool: "spotify_top_items", type, time_range }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      const params = new URLSearchParams({
        time_range: time_range ?? "medium_term",
        limit: String(limit ?? 10),
      });
      const res = await spotifyFetch(`/me/top/${type}?${params}`);
      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();
      if (!data.items?.length) {
        return { content: [{ type: "text" as const, text: `No top ${type} found for this time range.` }] };
      }

      const rangeLabel: Record<string, string> = {
        short_term: "last 4 weeks",
        medium_term: "last 6 months",
        long_term: "all time",
      };

      let lines: string[];
      if (type === "tracks") {
        lines = data.items.map((t: any, i: number) => `${i + 1}. ${formatTrack(t)}`);
      } else {
        lines = data.items.map((a: any, i: number) =>
          `${i + 1}. ${a.name} — ${a.followers?.total?.toLocaleString() ?? 0} followers\n   Genres: ${a.genres?.join(", ") || "N/A"}\n   URI: ${a.uri}`
        );
      }

      return { content: [{ type: "text" as const, text: `Top ${type} (${rangeLabel[time_range ?? "medium_term"]}):\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Top items failed");
      return { content: [{ type: "text" as const, text: `Failed to get top ${type}: ${msg}` }], isError: true };
    }
  }
);

const spotifyPlaylists = tool(
  "spotify_playlists",
  "List the user's Spotify playlists.",
  {
    limit: z.number().min(1).max(50).optional().describe("Number of playlists (default 20, max 50)"),
  },
  async ({ limit }) => {
    log.info({ tool: "spotify_playlists", limit }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      const res = await spotifyFetch(`/me/playlists?limit=${limit ?? 20}`);
      const error = await handleSpotifyError(res);
      if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

      const data = await res.json();
      if (!data.items?.length) {
        return { content: [{ type: "text" as const, text: "No playlists found." }] };
      }

      const lines = data.items.map((p: any, i: number) =>
        `${i + 1}. ${p.name}${p.public === false ? " (private)" : ""}\n   ${p.tracks?.total ?? 0} tracks · by ${p.owner?.display_name ?? "Unknown"}\n   URI: ${p.uri}`
      );

      return { content: [{ type: "text" as const, text: `Your playlists:\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Playlists failed");
      return { content: [{ type: "text" as const, text: `Failed to get playlists: ${msg}` }], isError: true };
    }
  }
);

const spotifyManagePlaylist = tool(
  "spotify_manage_playlist",
  "Create a new playlist or add tracks to an existing playlist.",
  {
    action: z.enum(["create", "add_tracks"]).describe("'create' to make a new playlist, 'add_tracks' to add tracks to an existing one"),
    name: z.string().optional().describe("Playlist name (required for 'create')"),
    description: z.string().optional().describe("Playlist description (for 'create')"),
    playlist_id: z.string().optional().describe("Playlist ID to add tracks to (required for 'add_tracks')"),
    uris: z.array(z.string()).optional().describe("Array of Spotify track URIs to add (for 'add_tracks')"),
  },
  async ({ action, name, description, playlist_id, uris }) => {
    log.info({ tool: "spotify_manage_playlist", action }, "Tool invoked");
    if (!isSpotifyConnected()) return { content: [{ type: "text" as const, text: NOT_CONNECTED }] };

    try {
      if (action === "create") {
        if (!name) {
          return { content: [{ type: "text" as const, text: "Playlist name is required for creating a playlist." }], isError: true };
        }

        // Get user ID
        const userRes = await spotifyFetch("/me");
        const userError = await handleSpotifyError(userRes);
        if (userError) return { content: [{ type: "text" as const, text: userError }], isError: true };
        const user = await userRes.json();

        const res = await spotifyFetch(`/users/${user.id}/playlists`, {
          method: "POST",
          body: JSON.stringify({ name, description: description ?? "", public: false }),
        });
        const error = await handleSpotifyError(res);
        if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

        const playlist = await res.json();
        return { content: [{ type: "text" as const, text: `Created playlist: "${playlist.name}"\nID: ${playlist.id}\nURI: ${playlist.uri}` }] };
      }

      if (action === "add_tracks") {
        if (!playlist_id) {
          return { content: [{ type: "text" as const, text: "Playlist ID is required for adding tracks." }], isError: true };
        }
        if (!uris?.length) {
          return { content: [{ type: "text" as const, text: "At least one track URI is required." }], isError: true };
        }

        const res = await spotifyFetch(`/playlists/${playlist_id}/tracks`, {
          method: "POST",
          body: JSON.stringify({ uris }),
        });
        const error = await handleSpotifyError(res);
        if (error) return { content: [{ type: "text" as const, text: error }], isError: true };

        return { content: [{ type: "text" as const, text: `Added ${uris.length} track(s) to playlist.` }] };
      }

      return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "Playlist management failed");
      return { content: [{ type: "text" as const, text: `Playlist operation failed: ${msg}` }], isError: true };
    }
  }
);

// ── MCP server ──────────────────────────────────────────────────────────────

export const SPOTIFY_TOOL_NAMES = [
  "mcp__spotify__spotify_auth",
  "mcp__spotify__spotify_now_playing",
  "mcp__spotify__spotify_recently_played",
  "mcp__spotify__spotify_search",
  "mcp__spotify__spotify_playback_control",
  "mcp__spotify__spotify_queue",
  "mcp__spotify__spotify_top_items",
  "mcp__spotify__spotify_playlists",
  "mcp__spotify__spotify_manage_playlist",
];

export const spotifyMcpServer = createSdkMcpServer({
  name: "spotify",
  tools: [
    spotifyAuth,
    spotifyNowPlaying,
    spotifyRecentlyPlayed,
    spotifySearch,
    spotifyPlaybackControl,
    spotifyQueue,
    spotifyTopItems,
    spotifyPlaylists,
    spotifyManagePlaylist,
  ],
});
