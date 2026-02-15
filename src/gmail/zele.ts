import { execFileSync, execSync } from "node:child_process";
import logger from "../logger";

const log = logger.child({ module: "zele" });

/**
 * Ensure zele is installed globally.
 * Returns the path to the zele binary.
 */
export function ensureZele(): string {
  try {
    return execSync("which zele", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error(
      "zele is not installed. Run: npm install -g zele"
    );
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
