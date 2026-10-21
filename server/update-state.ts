/** Where app state and managed-update state live. Dependency-free on purpose: the launcher
 * (server/managed.ts) imports it and must stay small and stable across releases. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
  const override = env["OVIS_STATE_DIR"];
  if (override) return override;
  const config = env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return adoptLegacyDir(join(config, "herdr-web-ui"), join(config, "ovis"));
}

/**
 * The state dir from before the rename moves to its new name once, leaving a link at the old
 * name for a launcher, plugin or older release that still uses it. Where the move fails (a file
 * held open on Windows, no permission), the old dir stays in use rather than starting empty.
 */
export function adoptLegacyDir(legacy: string, next: string): string {
  if (existsSync(next)) return next;
  try {
    if (!lstatSync(legacy).isDirectory()) return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return next;
    throw error;
  }
  try {
    renameSync(legacy, next);
  } catch (error) {
    console.error(`cannot move ${legacy} to ${next}, so the old state dir stays in use: ${(error as Error).message}`);
    return legacy;
  }
  try {
    // "junction" needs no privilege on Windows; other platforms ignore the type
    symlinkSync(next, legacy, "junction");
  } catch (error) {
    console.error(`moved ${legacy} to ${next} but cannot link the old name to it: ${(error as Error).message}`);
  }
  return next;
}

/** One update state per source checkout and port, so two checkouts or ports never share builds. */
export function updateStateDir(root: string, port: number, stateDir = defaultStateDir()): string {
  return join(resolve(stateDir), "updates",
    createHash("sha256").update(`${resolve(root)}:${port}`).digest("hex").slice(0, 16));
}

/** A supervisor exits with this after an install: "start the supervisor of the release now active"
 * (EX_TEMPFAIL, never a crash code). */
export const HANDOVER_EXIT = 75;
