import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import logger from "../logger";

const log = logger.child({ module: "zele" });

const ZELE_DIR = join(homedir(), ".kairo", "zele");
const ZELE_BIN = join(ZELE_DIR, "node_modules", ".bin", "zele");

/**
 * Ensure zele is installed at ~/.kairo/zele.
 * Installs it via npm if not present.
 */
export function ensureZele(): string {
  if (existsSync(ZELE_BIN)) return ZELE_BIN;

  log.info("zele not found, installing to ~/.kairo/zele ...");
  mkdirSync(ZELE_DIR, { recursive: true });

  execSync("npm init -y", { cwd: ZELE_DIR, stdio: "ignore" });
  execSync("npm install zele@latest", {
    cwd: ZELE_DIR,
    stdio: "inherit",
    timeout: 120_000,
  });

  if (!existsSync(ZELE_BIN)) {
    throw new Error("zele installation failed — binary not found after npm install");
  }

  log.info("zele installed successfully");
  return ZELE_BIN;
}

/**
 * Run a zele CLI command and return stdout.
 */
export function runZele(args: string[], timeoutMs = 30_000): string {
  const bin = ensureZele();
  log.debug({ args }, "Running zele command");

  try {
    const output = execFileSync(bin, args, {
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
