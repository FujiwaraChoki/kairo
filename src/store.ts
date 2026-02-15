import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const cache = new Map<string, unknown>();

export function readJson<T>(path: string, fallback: T): T {
  if (cache.has(path)) return cache.get(path) as T;
  try {
    if (!existsSync(path)) return fallback;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    cache.set(path, data);
    return data as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, data: unknown): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  cache.set(path, data);
}

export function updateJson<T>(path: string, fallback: T, fn: (data: T) => T): void {
  const data = readJson(path, fallback);
  const updated = fn(data);
  writeJson(path, updated);
}
