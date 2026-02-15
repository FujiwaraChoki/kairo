import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DB_PATH } from "../constants";
import logger from "../logger";

const log = logger.child({ module: "db" });

let db: Database.Database;

const MIGRATIONS: string[] = [
  // Migration 1: initial schema
  `
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id         INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    telegram_message_id  INTEGER,
    created_at      INTEGER NOT NULL,
    token_estimate  INTEGER NOT NULL,
    compacted_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_active
    ON messages (chat_id, compacted_at);

  CREATE TABLE IF NOT EXISTS tracked_telegram_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id             INTEGER NOT NULL,
    telegram_message_id INTEGER NOT NULL,
    created_at          INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tracked_chat
    ON tracked_telegram_messages (chat_id);

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );

  INSERT INTO schema_version (version) VALUES (1);
  `,
];

function runMigrations(database: Database.Database) {
  database.pragma("journal_mode = WAL");

  const hasVersionTable = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();

  let currentVersion = 0;
  if (hasVersionTable) {
    const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
      | { version: number }
      | undefined;
    currentVersion = row?.version ?? 0;
  }

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    log.info({ from: currentVersion, to: i + 1 }, "Running migration");
    database.exec(MIGRATIONS[i]);
  }

  if (currentVersion < MIGRATIONS.length && currentVersion > 0) {
    database.prepare("UPDATE schema_version SET version = ?").run(MIGRATIONS.length);
  }
}

export function initDatabase(): Database.Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  runMigrations(db);
  log.info({ path: DB_PATH }, "Database initialized");
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDatabase() first");
  return db;
}
