import { execFileSync, execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import logger from "../logger";

const log = logger.child({ module: "zele" });

let cachedEntry: string | null = null;

/**
 * Ensure zele is installed globally.
 * Returns the path to the actual JS entry point (not the shell wrapper).
 */
export function ensureZele(): string {
  if (cachedEntry) return cachedEntry;

  try {
    // which zele -> /usr/lib/node_modules/zele/bin/zele (shell wrapper)
    const binPath = execSync("which zele", { encoding: "utf-8" }).trim();
    // Follow symlinks to the real file, then find package.json
    const realBin = execSync(`realpath "${binPath}"`, { encoding: "utf-8" }).trim();
    const pkgDir = resolve(dirname(realBin), "..");
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf-8"));
    const binField = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.zele;

    if (!binField) throw new Error("Cannot find zele bin entry in package.json");

    cachedEntry = resolve(pkgDir, binField);
    return cachedEntry;
  } catch (err: any) {
    if (err.message?.includes("Cannot find zele")) throw err;
    throw new Error("zele is not installed. Run: npm install -g zele");
  }
}

/**
 * Run a zele CLI command and return stdout.
 */
export function runZele(args: string[], timeoutMs = 30_000): string {
  const bin = ensureZele();
  log.debug({ args }, "Running zele command");

  try {
    const output = execFileSync("node", [bin, ...args], {
      encoding: "utf-8",
      timeout: timeoutMs,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return output.trim();
  } catch (err: any) {
    // execFileSync throws with stderr/stdout on the error object
    const stderr = err.stderr?.toString?.()?.trim?.() ?? "";
    const stdout = err.stdout?.toString?.()?.trim?.() ?? "";
    const msg = stderr || stdout || (err instanceof Error ? err.message : String(err));
    log.error({ args, error: msg }, "zele command failed");
    throw new Error(msg);
  }
}

/**
 * Check if any Gmail account is authenticated.
 */
export function isLoggedIn(): boolean {
  try {
    const output = runZele(["whoami"]);
    // If whoami returns account info, we're logged in
    return output.length > 0 && !output.toLowerCase().includes("no account");
  } catch {
    return false;
  }
}
