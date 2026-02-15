import { resolve } from "node:path";
import { readJson, writeJson } from "../store";
import { getTelegramApi } from "../telegram";
import { DATA_DIR } from "../constants";
import type { Reminder } from "./types";
import logger from "../logger";

const log = logger.child({ module: "scheduler" });
const REMINDERS_PATH = resolve(DATA_DIR, "reminders.json");
const CHECK_INTERVAL = 30_000; // 30 seconds

export function startReminderScheduler(): void {
  log.info("Reminder scheduler started (checking every 30s)");

  setInterval(() => {
    try {
      const reminders = readJson<Reminder[]>(REMINDERS_PATH, []);
      const now = Date.now();
      let changed = false;

      for (const r of reminders) {
        if (r.fired) continue;
        if (new Date(r.time).getTime() <= now) {
          r.fired = true;
          changed = true;
          fireReminder(r);
        }
      }

      if (changed) writeJson(REMINDERS_PATH, reminders);
    } catch (err) {
      log.error({ err }, "Scheduler tick failed");
    }
  }, CHECK_INTERVAL);
}

async function fireReminder(r: Reminder): Promise<void> {
  try {
    const api = getTelegramApi();
    await api.sendMessage(r.chatId, `⏰ Reminder: ${r.message}`);
    log.info({ id: r.id, chatId: r.chatId }, "Reminder fired");
  } catch (err) {
    log.error({ err, id: r.id }, "Failed to fire reminder");
  }
}
