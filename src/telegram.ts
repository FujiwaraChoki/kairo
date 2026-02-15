import type { Telegram } from "telegraf";

let telegramApi: Telegram | null = null;

export function setTelegramApi(api: Telegram): void {
  telegramApi = api;
}

export function getTelegramApi(): Telegram {
  if (!telegramApi) throw new Error("Telegram API not initialized — call setTelegramApi() first");
  return telegramApi;
}
