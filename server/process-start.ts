import { readFileSync } from "node:fs";

/** `ps -o etime=`: `[[dd-]hh:]mm:ss` since the process started. */
export function parseElapsed(text: string): number | null {
  const match = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(text);
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!);
}

/**
 * When a process started, in ms since the epoch: Linux counts it in /proc (USER_HZ
 * ticks after boot); macOS has no /proc, so there `ps` tells how long it has run (to the
 * second, which is all the callers compare). null where neither answers.
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform === "darwin") {
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const elapsed = ps.exitCode === 0 ? parseElapsed(ps.stdout.toString()) : null;
      return elapsed === null ? null : Date.now() - elapsed * 1000;
    } catch {
      return null;
    }
  }
  try {
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    const boot = Number(readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m)?.[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * A time no later than the process started, in ms since the epoch: what a thread begun since
 * must be no older than. Codex 0.163 creates its thread as its process starts, often in the same
 * millisecond tick on Linux and always in the same second as macOS's `ps` reports; the bound from
 * above this replaced left such a thread out, and two Codex panes of one directory with short
 * answers both said they could not tell. An older thread let in with it makes two begun
 * since, and two tell nothing.
 */
export function processStartLowerBound(pid: number): number | null {
  if (process.platform === "darwin") {
    // the clock read before `ps`, which counts whole seconds: the start is after now - (etime + 1) s
    const now = Date.now();
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "etime=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const elapsed = ps.exitCode === 0 ? parseElapsed(ps.stdout.toString()) : null;
      return elapsed === null ? null : now - (elapsed + 1) * 1000;
    } catch { return null; }
  }
  if (process.platform !== "linux") return null;
  try {
    // the wall clock first, then uptime and the start ticks, each cut to 10 ms: the start is
    // after now - uptime + ticks, less one tick for the uptime read last
    const now = Date.now();
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const ticks = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]);
    return Number.isFinite(ticks) && Number.isFinite(uptime) ? now - uptime * 1000 + ticks * 10 - 10 : null;
  } catch { return null; }
}
