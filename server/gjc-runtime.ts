/**
 * gjc sessions: the process identity GJC keys its terminal breadcrumb by, and the
 * resolver from a pane to the one transcript that process writes. It answers null
 * rather than guessing; conversation.ts turns that into the chat lens's fallback.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { readRange } from "./codex.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";
import { parseOmpTranscript } from "./transcript-records.ts";

export interface GjcTerminal { id: string; startedAt: number }

/** Native gjc and interpreter-launched gjc scripts both occur in process_info. */
export function isGjcProcess(argv: readonly string[]): boolean {
  const executable = /(^|\/)gjc(?:\.[cm]?js)?$/;
  return executable.test(argv[0] ?? "") ||
    (/(^|\/)(?:bun|node)(?:\.exe)?$/.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
}

/** GJC's native terminal-sessions key, not the most recently written cwd session. */
export function gjcTerminal(pid: number): GjcTerminal | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const startedAt = processStartedAt(pid);
      if (startedAt === null) return null;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const tmux = env.find((word) => word.startsWith("TMUX="))?.slice(5);
      const pane = env.find((word) => word.startsWith("TMUX_PANE="))?.slice(10);
      if (tmux && pane && /^%\d+$/.test(pane)) return { id: `tmux-${pane}`, startedAt };
      const tty = readlinkSync(`/proc/${pid}/fd/0`);
      if (!/^\/dev\/(?:pts\/\d+|tty[\w-]+)$/.test(tty)) return null;
      return { id: tty.slice(5).replaceAll("/", "-"), startedAt };
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "tty=", "-o", "lstart="], {
        encoding: "utf8", timeout: 1500, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"],
      });
      return parseGjcPs(output);
    }
  } catch { /* process exited or its terminal metadata is unavailable */ }
  return null;
}

export function parseGjcPs(output: string): GjcTerminal | null {
  const match = output.trim().match(/^(?:\/dev\/)?(ttys\d+)\s+(.+)$/);
  if (!match) return null;
  const startedAt = Date.parse(match[2]!);
  return Number.isFinite(startedAt) ? { id: match[1]!, startedAt } : null;
}

/**
 * The cwd a gjc transcript names in its first line (`{"type":"session",...}`),
 * or null when the file is not one. Read bounded: only the header decides, and
 * a rejected candidate can be megabytes.
 */
function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null; // the file vanished between the listing and this read
  }
  try {
    const buffer = Buffer.alloc(4096);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const header = JSON.parse(buffer.subarray(0, size).toString("utf8").split("\n")[0] ?? "") as { type?: string; cwd?: unknown };
    return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
  } catch {
    return null; // not a gjc transcript, or a header longer than the read
  } finally {
    closeSync(fd);
  }
}

/** Unique visible transcript evidence; timestamps never choose a winner. */
export function matchGjcTranscript(screen: string, candidates: { path: string; text: string }[]): string | null {
  const normalize = (value: string) => value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
  const visible = normalize(screen);
  const matches = new Set<string>();
  for (const file of candidates) {
    const turns = parseOmpTranscript(file.text, Infinity).filter(turn => turn.role === "assistant").slice(-8);
    if (turns.some(turn => turn.parts.some(part => {
      if (part.kind !== "text") return false;
      const anchor = normalize(part.text).slice(-160);
      return anchor.length >= 64 && visible.includes(anchor);
    }))) matches.add(file.path);
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

/** Bound both directory enumeration and content reads; never match an arbitrary subset. */
export function gjcDisplayCandidates(root: string, cwd: string): { path: string; text: string }[] {
  try {
    const dirs = readdirSync(root, { withFileTypes: true });
    if (dirs.length > 512) return [];
    const paths = new Set<string>();
    let inspected = 0;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const entries = readdirSync(join(root, dir.name));
      inspected += entries.length;
      if (inspected > 4096) return [];
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const path = realpathSync(join(root, dir.name, name));
        if (path.startsWith(`${root}/`) && statSync(path).isFile() && transcriptCwd(path) === cwd) paths.add(path);
      }
    }
    if (paths.size > 64) return [];
    return [...paths].map(path => {
      const size = statSync(path).size;
      // readRange drops through the first newline; starting one byte early keeps a record
      // the 64 KiB window starts exactly on, and still drops one it cuts
      return { path, text: readRange(path, Math.max(0, size - 65536 - 1), size) };
    });
  } catch { return []; }
}

/**
 * The session a transcript belongs to. GJC keeps a session's subagents beside it, as
 * `<store>/<session>/<task>.jsonl` next to `<store>/<session>.jsonl`, and they run inside the
 * session's own process. That process points the terminal breadcrumb at a subagent's file while it
 * runs, and leaves it there; a subagent's file can be the one it holds open. Either way the pane
 * shows the session, so a subagent's file stands for its session's, and anything else is refused.
 */
export function gjcSessionFile(root: string, path: string): string | null {
  if (!path.startsWith(`${root}/`) || !path.endsWith(".jsonl")) return null;
  const parts = path.slice(root.length + 1).split("/");
  if (parts.length === 2) return path;
  if (parts.length !== 3) return null;
  const session = join(root, parts[0]!, `${parts[1]!}.jsonl`);
  try { return statSync(session).isFile() ? session : null; } catch { return null; }
}

/** Validate the native two-line terminal breadcrumb and reject reused-terminal leftovers. */
export function gjcBreadcrumbPath(home: string, cwd: string, terminalId: string, startedAt: number): string | null {
  if (!/^(?:pts-\d+|tty[\w-]+|tmux-%\d+)$/.test(terminalId) || !Number.isFinite(startedAt)) return null;
  try {
    const marker = join(home, ".gjc", "agent", "terminal-sessions", terminalId);
    const stat = statSync(marker);
    if (!stat.isFile() || stat.size > 8192 || stat.mtimeMs < startedAt - 1000) return null;
    const [savedCwd, savedPath] = readFileSync(marker, "utf8").split("\n");
    if (!savedCwd || !savedPath || realpathSync(savedCwd) !== realpathSync(cwd)) return null;
    const root = realpathSync(join(home, ".gjc", "agent", "sessions"));
    const saved = realpathSync(savedPath);
    if (!statSync(saved).isFile()) return null;
    const path = gjcSessionFile(root, saved);
    if (!path) return null;
    const headerCwd = transcriptCwd(path);
    return headerCwd && realpathSync(headerCwd) === realpathSync(cwd) ? path : null;
  } catch { return null; }
}

/**
 * A directory descriptor or cwd proves only the store, not the active session.
 * Prefer an exact open transcript, then GJC's terminal-scoped breadcrumb written
 * during this process lifetime. Never infer ownership from cwd or session recency.
 */
export async function gjcTranscriptForPane(paneId: string, cwd: string, home = process.env["HOME"] ?? ""): Promise<string | null> {
  let root: string;
  try { root = realpathSync(join(home, ".gjc", "agent", "sessions")); }
  catch { return null; }
  const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
    "pane.process_info",
    { pane_id: paneId },
  ).catch(() => null);
  const paths = new Set<string>();
  const breadcrumbs = new Set<string>();
  let running = false;
  for (const process of info?.process_info?.foreground_processes ?? []) {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    if (typeof process.pid !== "number" || !isGjcProcess(argv)) continue;
    running = true;
    const terminal = gjcTerminal(process.pid);
    if (terminal) {
      const path = gjcBreadcrumbPath(home, cwd, terminal.id, terminal.startedAt);
      if (path) breadcrumbs.add(path);
    }
    let fds: string[] = [];
    try { fds = readdirSync(`/proc/${process.pid}/fd`); } catch { /* macOS uses the native breadcrumb */ }
    for (const fd of fds) {
      try {
        const open = realpathSync(readlinkSync(`/proc/${process.pid}/fd/${fd}`));
        const target = statSync(open).isFile() ? gjcSessionFile(root, open) : null;
        if (target && transcriptCwd(target) === cwd) paths.add(target);
      } catch { /* closed, deleted or unreadable descriptor */ }
    }
  }
  const candidates = paths.size > 0 ? paths : breadcrumbs;
  if (candidates.size === 1) return [...candidates][0]!;
  if (candidates.size > 1 || !running) return null;
  // Some GJC builds publish neither a file descriptor nor a terminal breadcrumb.
  // Match substantial assistant text in this pane against every same-cwd candidate.
  const files = gjcDisplayCandidates(root, cwd);
  if (files.length > 0) {
    const screen = await paneRead({ paneId, source: "visible", lines: 1000 }).catch(() => null);
    const matched = screen ? matchGjcTranscript(screen.text, files) : null;
    if (matched) return matched;
  }
  return null;
}
