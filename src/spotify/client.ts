import { getTokens, refreshAccessToken } from "./auth";
import logger from "../logger";

const log = logger.child({ module: "spotify-client" });

const API_BASE = "https://api.spotify.com/v1";

export function isSpotifyConnected(): boolean {
  const tokens = getTokens();
  return tokens !== null && !!tokens.access_token;
}

async function getValidAccessToken(): Promise<string> {
  const tokens = getTokens();
  if (!tokens) throw new Error("Not connected to Spotify");

  // Refresh if within 60s of expiry
  if (Date.now() >= tokens.expires_at - 60_000) {
    log.debug("Token expiring soon, refreshing");
    const refreshed = await refreshAccessToken();
    return refreshed.access_token;
  }

  return tokens.access_token;
}

export async function spotifyFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getValidAccessToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // On 401, try one refresh + retry
  if (res.status === 401) {
    log.warn("Got 401, attempting token refresh");
    const refreshed = await refreshAccessToken();
    return fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${refreshed.access_token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }

  return res;
}
