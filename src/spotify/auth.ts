import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { readJson, writeJson } from "../store";
import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, SPOTIFY_CALLBACK_PORT, DATA_DIR } from "../constants";
import logger from "../logger";
import type { SpotifyTokens } from "./types";

const log = logger.child({ module: "spotify-auth" });

const TOKENS_PATH = resolve(DATA_DIR, "spotify_tokens.json");
const TOKEN_URL = "https://accounts.spotify.com/api/token";

const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");

const pendingStates = new Set<string>();
let callbackServer: Server | null = null;

// ── Token persistence ────────────────────────────────────────────────────────

export function getTokens(): SpotifyTokens | null {
  const tokens = readJson<SpotifyTokens | null>(TOKENS_PATH, null);
  return tokens;
}

export function saveTokens(tokens: SpotifyTokens): void {
  writeJson(TOKENS_PATH, tokens);
}

// ── Auth URL ─────────────────────────────────────────────────────────────────

export function getAuthUrl(): string {
  const state = randomBytes(16).toString("hex");
  pendingStates.add(state);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID!,
    scope: SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

// ── Token exchange ───────────────────────────────────────────────────────────

function authHeader(): string {
  return "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
}

export async function exchangeCode(code: string): Promise<SpotifyTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const tokens: SpotifyTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };

  saveTokens(tokens);
  log.info("Spotify tokens saved");
  return tokens;
}

export async function refreshAccessToken(): Promise<SpotifyTokens> {
  const current = getTokens();
  if (!current?.refresh_token) {
    throw new Error("No refresh token available — re-authenticate with Spotify");
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: authHeader(),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const tokens: SpotifyTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? current.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? current.scope,
  };

  saveTokens(tokens);
  log.info("Spotify tokens refreshed");
  return tokens;
}

// ── Callback server ──────────────────────────────────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Spotify Connected</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#191414;color:#1DB954}
h1{font-size:2rem}p{color:#b3b3b3}</style></head>
<body><div style="text-align:center"><h1>✓ Spotify Connected</h1><p>You can close this tab and return to Telegram.</p></div></body></html>`;

export function startCallbackServer(): Promise<void> {
  return new Promise((resolveStart, rejectStart) => {
    if (callbackServer) {
      resolveStart();
      return;
    }

    callbackServer = createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${SPOTIFY_CALLBACK_PORT}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        log.warn({ error }, "Spotify auth denied");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Auth failed: ${error}</h1>`);
        return;
      }

      if (!state || !pendingStates.has(state)) {
        log.warn("Invalid state parameter");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Invalid state parameter</h1>");
        return;
      }

      pendingStates.delete(state);

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing authorization code</h1>");
        return;
      }

      try {
        await exchangeCode(code);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        log.info("Spotify OAuth callback successful");

        // Shut down server after success
        setTimeout(() => stopCallbackServer(), 2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ err }, "OAuth callback failed");
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Auth failed</h1><p>${msg}</p>`);
      }
    });

    callbackServer.listen(SPOTIFY_CALLBACK_PORT, () => {
      log.info({ port: SPOTIFY_CALLBACK_PORT }, "Spotify callback server started");
      resolveStart();
    });

    callbackServer.on("error", (err) => {
      log.error({ err }, "Callback server error");
      callbackServer = null;
      rejectStart(err);
    });
  });
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    log.info("Spotify callback server stopped");
  }
}
