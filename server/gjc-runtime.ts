/**
 * gjc sessions: the process identity GJC keys its terminal breadcrumb by, and the
 * resolver from a pane to the one transcript that process writes. It answers null
 * rather than guessing; conversation.ts turns that into the chat lens's fallback.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join, type PlatformPath } from "node:path";

import { readRange } from "./codex.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import { descendantArgv, windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

export interface GjcTerminal { id: string; startedAt: number }

/** Native gjc and interpreter-launched gjc scripts both occur in process_info. */
export function isGjcProcess(argv: readonly string[]): boolean {
  // a Windows process comes with backslashes and `.exe`
  const executable = /(^|[\\/])gjc(?:\.exe|\.[cm]?js)?$/i;
  return executable.test(argv[0] ?? "") ||
    (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && executable.test(argv[1] ?? ""));
}

const PROCESS_TABLE_MS = 5000;
let processTable: { at: number; rows: Promise<ProcessRow[]> } | null = null;

/**
 * The Windows process table, read at most once per PROCESS_TABLE_MS. The chat polls a pane
 * every 2 s and each read starts a PowerShell (about 1.3 s on a real PC), so the polls of a
 * few seconds share one; a gjc that left its pane can still count as running for that long.
 */
export function recentProcessTable(read: () => Promise<ProcessRow[]> = windowsProcessTable, now = Date.now()): Promise<ProcessRow[]> {
  if (processTable && now - processTable.at < PROCESS_TABLE_MS) return processTable.rows;
  const entry = { at: now, rows: read() };
  processTable = entry;
  // an empty table is a read that failed: the next poll asks again
  void entry.rows.then((rows) => { if (rows.length === 0 && processTable === entry) processTable = null; });
  return entry.rows;
}

/**
 * The gjc process below a pane's shell on a Windows PC, or null. herdr names only the shell
 * there (windows-processes.ts), so the PC's process table answers; elsewhere herdr's
 * foreground processes are the answer and the table is never asked.
 */
export async function gjcPidUnderShell(
  shellPid: unknown,
  platform: string = process.platform,
  table: () => Promise<ProcessRow[]> = recentProcessTable,
): Promise<number | null> {
  if (platform !== "win32" || typeof shellPid !== "number") return null;
  const rows = await table();
  const seen = new Set<number>([shellPid]);
  let level = [shellPid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      // nearest first: the session's own process, not the helper gjc starts below itself
      if (descendantArgv([row], row.parent).some(isGjcProcess)) return row.pid;
      seen.add(row.pid);
      next.push(row.pid);
    }
    level = next;
  }
  return null;
}

const windowsBindings = new Map<string, { pid: number; path: string }>();

/**
 * A Windows pane's session. The screen is the only evidence there, and it is gone whenever no
 * recent answer's tail is visible (a long list, tool output; live-verified: the lens fell back
 * for the whole of such an answer). So what the screen once showed is kept for the pane while
 * the same gjc process runs in it. The screen still wins when it shows another session, and a
 * pane is never bound without it.
 */
export async function boundGjcTranscript(paneId: string, gjcPid: number | null, match: () => Promise<string | null>): Promise<string | null> {
  const bound = windowsBindings.get(paneId);
  if (gjcPid === null || bound && bound.pid !== gjcPid) windowsBindings.delete(paneId);
  if (gjcPid === null) return null;
  const path = await match();
  if (path) windowsBindings.set(paneId, { pid: gjcPid, path });
  return path ?? (bound?.pid === gjcPid ? bound.path : null);
}

/** Forget the bindings and the process table kept between polls. */
export function forgetGjcState(): void {
  windowsBindings.clear();
  processTable = null;
}

/**
 * Where `file` sits inside `root`, as path segments, or null when it is not inside. The
 * platform's own rules decide: a Windows path comes with backslashes and a drive letter whose
 * case means nothing, and a prefix test would take `sessions-evil` or a `..` for the store.
 */
export function storeRelative(root: string, file: string, paths: PlatformPath = nodePath): string[] | null {
  const relative = paths.relative(root, file);
  // another drive or share comes back absolute
  if (relative === "" || paths.isAbsolute(relative)) return null;
  const parts = relative.split(paths.sep);
  return parts[0] === ".." ? null : parts;
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
        if (storeRelative(root, path) && statSync(path).isFile() && transcriptCwd(path) === cwd) paths.add(path);
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
export function gjcSessionFile(root: string, path: string, paths: PlatformPath = nodePath): string | null {
  const parts = path.endsWith(".jsonl") ? storeRelative(root, path, paths) : null;
  if (!parts) return null;
  if (parts.length === 2) return path;
  if (parts.length !== 3) return null;
  const session = paths.join(root, parts[0]!, `${parts[1]!}.jsonl`);
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
  const info = await herdrRpc<{ process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; argv?: unknown }[] } }>(
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
  if (candidates.size > 1) return null;
  // Some GJC builds publish neither a file descriptor nor a terminal breadcrumb.
  // Match substantial assistant text in this pane against every same-cwd candidate.
  const onScreen = async () => {
    const files = gjcDisplayCandidates(root, cwd);
    if (files.length === 0) return null;
    const screen = await paneRead({ paneId, source: "visible", lines: 1000 }).catch(() => null);
    return screen ? matchGjcTranscript(screen.text, files) : null;
  };
  if (running) return onScreen();
  // a Windows pane has neither descriptors nor a breadcrumb to read: gjc under its shell, then the screen
  return boundGjcTranscript(paneId, await gjcPidUnderShell(info?.process_info?.shell_pid), onScreen);
}
