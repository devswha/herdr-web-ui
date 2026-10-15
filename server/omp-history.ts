/**
 * Earlier omp sessions of a folder, to list and resume one exactly (`omp --resume <file>`).
 * omp keeps one JSONL per session under ~/.omp/agent/sessions/<encoded folder>/, and a session
 * can be tens of megabytes: a listing reads each candidate's first bytes only (its header names
 * the folder and id, its first user message makes the preview) and the file's mtime says when it
 * was last written. Nothing here reads a whole transcript or the tail.
 *
 * Only this PC's default store is read: a session from `--profile` or `--session-dir` is not
 * listed, and a remote PC never reaches this (its proxy allowlist, server/machine-api.ts, has no
 * route for it, and the browser offers it for the local PC only).
 */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath, { isAbsolute, join, resolve } from "node:path";

import type { HerdrPane, OmpSessionResumed, OmpSessionSummary } from "../shared/protocol.ts";
import { storeRelative } from "./gjc-runtime.ts";
import { isJsonObject } from "./http.ts";

/** Sessions one listing answers with at most; the caller can ask for fewer. */
export const OMP_SESSIONS_DEFAULT_LIMIT = 20;
export const OMP_SESSIONS_MAX_LIMIT = 50;
/** File names looked at (and statted) per folder: a folder with more has its oldest sessions left out. */
const MAX_FILES_LISTED = 2000;
/** Headers read per listing, whatever they turn out to be: bounds the I/O when most candidates belong to another folder. */
const MAX_HEADERS_READ = 400;
/** What is read of a session file: its header and the first user message are within it, or there is no preview. */
const HEAD_BYTES = 128 * 1024;
const PREVIEW_CHARS = 160;

export function ompSessionsRoot(home: string = homedir()): string {
  return join(home, ".omp", "agent", "sessions");
}

/** A path as one file is compared by: its real location, or the path itself while the file is not written yet. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * The directory names omp may keep a folder's sessions in (its encoding differs by version and
 * by where the folder is: under the temp root, under home, or elsewhere). The names are only
 * candidates: every file's own header decides which folder it belongs to.
 */
export function ompSessionDirNames(cwd: string, home: string = homedir(), temp: string = tmpdir()): string[] {
  const names = new Set<string>();
  const encode = (value: string): string => value.replace(/[/\\:]/g, "-");
  for (const folder of new Set([resolve(cwd), canonical(cwd)])) {
    const abs = `--${encode(folder.replace(/^[/\\]/, ""))}--`;
    names.add(abs);
    for (const [prefix, root] of [["-tmp", temp], ["-", home]] as const) {
      for (const base of new Set([resolve(root), canonical(root)])) {
        const relative = nodePath.relative(base, folder);
        if (relative.startsWith("..") || isAbsolute(relative)) continue;
        const encoded = encode(relative);
        names.add(encoded === "" ? prefix : prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`);
      }
    }
  }
  return [...names];
}

function sameFolder(recorded: string, cwd: string): boolean {
  if (!isAbsolute(recorded)) return false;
  const left = process.platform === "win32" ? (value: string) => value.toLowerCase() : (value: string) => value;
  return left(resolve(recorded)) === left(resolve(cwd)) || left(canonical(recorded)) === left(canonical(cwd));
}

interface Head { id: string; cwd: string; title: string | null; preview: string | null }

function userText(message: unknown): string | null {
  if (!isJsonObject(message) || message["role"] !== "user") return null;
  const content = message["content"];
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.map((part: unknown) => isJsonObject(part) && part["type"] === "text" && typeof part["text"] === "string" ? part["text"] : "") : [];
  const flat = parts.join(" ").replace(/\s+/gu, " ").trim();
  return flat === "" ? null : [...flat].slice(0, PREVIEW_CHARS).join("");
}

/** The first bytes of a session file as its header and preview, or null when the file is no omp session. */
export function readOmpHead(path: string): Head | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(HEAD_BYTES);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, size).toString("utf8").split("\n");
    // a read that filled the buffer ends inside a line
    if (size === buffer.length) lines.pop();
    let header: { id: string; cwd: string; title: unknown } | null = null;
    let title: string | null = null;
    let preview: string | null = null;
    for (const line of lines) {
      let record: unknown;
      try { record = JSON.parse(line); } catch { if (header === null) return null; continue; }
      if (!isJsonObject(record)) return null;
      if (header === null && record["type"] === "title") {
        if (typeof record["title"] === "string" && record["title"].trim() !== "") title = record["title"].trim();
      } else if (header === null) {
        const { type, id, cwd } = record;
        if (type !== "session" || typeof id !== "string" || id === "" || typeof cwd !== "string") return null;
        header = { id, cwd, title: record["title"] };
      } else if (preview === null && record["type"] === "message") {
        preview = userText(record["message"]);
      }
      if (header !== null && preview !== null) break;
    }
    if (header === null) return null;
    if (title === null && typeof header.title === "string" && header.title.trim() !== "") title = header.title.trim();
    return { id: header.id, cwd: header.cwd, title, preview };
  } catch { return null; } finally { closeSync(fd); }
}

export interface OmpSessionListing { sessions: OmpSessionSummary[]; has_more: boolean }

/**
 * The folder's sessions, newest write first, except those in `open` (the files open panes show:
 * resuming one of them would start a second omp on a transcript another is appending to).
 * `has_more`: the cap, or the work bound, cut the listing short.
 */
export function listOmpSessions(cwd: string, open: ReadonlySet<string>, limit: number, home: string = homedir(), temp: string = tmpdir()): OmpSessionListing {
  const root = ompSessionsRoot(home);
  const candidates: { path: string; mtimeMs: number; size: number }[] = [];
  for (const name of ompSessionDirNames(cwd, home, temp)) {
    const directory = join(root, name);
    let files: string[];
    try { files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => entry.name); }
    catch { continue; }
    // file names start with the session's creation time: the newest are kept when a folder holds more than is looked at
    files.sort().reverse();
    for (const file of files.slice(0, MAX_FILES_LISTED)) {
      const path = join(directory, file);
      try {
        const stat = statSync(path);
        if (stat.isFile()) candidates.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch { /* removed since the listing */ }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? 1 : -1));
  const sessions: OmpSessionSummary[] = [];
  let reads = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (sessions.length >= limit || reads >= MAX_HEADERS_READ) return { sessions, has_more: index < candidates.length };
    if (open.has(canonical(candidate.path))) continue;
    reads += 1;
    const head = readOmpHead(candidate.path);
    if (head === null || !sameFolder(head.cwd, cwd)) continue;
    sessions.push({ session_id: head.id, path: candidate.path, title: head.title, preview: head.preview, updated_at: new Date(candidate.mtimeMs).toISOString(), size_bytes: candidate.size });
  }
  return { sessions, has_more: false };
}

/**
 * The session file `path` names, only when it is a main session transcript directly inside
 * the omp store (a subagent's file lives one level deeper) whose header says it belongs to
 * `cwd`; null for anything else, a link out of the store included.
 */
export function resolveOmpSession(path: unknown, cwd: string, home: string = homedir()): { path: string; id: string } | null {
  if (typeof path !== "string" || !path.endsWith(".jsonl") || !isAbsolute(path)) return null;
  let root: string;
  let file: string;
  try { root = realpathSync(ompSessionsRoot(home)); file = realpathSync(path); } catch { return null; }
  if (storeRelative(root, file)?.length !== 2) return null;
  const head = readOmpHead(file);
  return head !== null && sameFolder(head.cwd, cwd) ? { path: file, id: head.id } : null;
}

/**
 * The session file each open omp pane shows, by pane. herdr names it for most panes; for one it
 * does not, `held` asks the pane's own omp process (server/omp.ts).
 */
export async function openOmpSessions(panes: readonly HerdrPane[], held: (pane: HerdrPane) => Promise<string | null>): Promise<Map<string, string>> {
  const open = new Map<string, string>();
  await Promise.all(panes.map(async (pane) => {
    const session = pane.agent_session;
    if (pane.agent !== "omp" && session?.agent !== "omp") return;
    const reported = session?.agent === "omp" && session.kind === "path" && session.value.endsWith(".jsonl") ? session.value : null;
    const path = reported ?? await held(pane).catch(() => null);
    if (path !== null) open.set(canonical(path), pane.pane_id);
  }));
  return open;
}

export interface OmpResumeDeps {
  panes: () => Promise<readonly HerdrPane[]>;
  /** see openOmpSessions */
  open: (panes: readonly HerdrPane[]) => Promise<Map<string, string>>;
  focus: (paneId: string) => Promise<void>;
  createTab: (workspaceId: string, cwd: string) => Promise<{ workspace_id: string; pane_id: string }>;
  /** the app's one agent launch (index.ts agentLaunch): a failure is answered, not thrown */
  launch: (paneId: string, args: string[]) => Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }>;
}

/** Starts a listed session in a new tab, once however many ask at once, or brings forward the pane that already has it. */
export class OmpResumer {
  private readonly flights = new Map<string, Promise<OmpSessionResumed>>();
  /** the pane this server started each session in, for the moment herdr has not named its transcript yet */
  private readonly started = new Map<string, string>();

  constructor(private readonly deps: OmpResumeDeps) {}

  resume(session: { path: string }, workspaceId: string, cwd: string): Promise<OmpSessionResumed> {
    const key = canonical(session.path);
    const running = this.flights.get(key);
    if (running !== undefined) return running;
    const flight = this.run(key, workspaceId, cwd).finally(() => { this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }

  private async run(path: string, workspaceId: string, cwd: string): Promise<OmpSessionResumed> {
    const panes = await this.deps.panes();
    const startedHere = this.started.get(path);
    if (startedHere !== undefined && !panes.some((pane) => pane.pane_id === startedHere)) this.started.delete(path);
    const holder = (await this.deps.open(panes)).get(path) ?? this.started.get(path);
    const open = holder === undefined ? undefined : panes.find((pane) => pane.pane_id === holder);
    if (open !== undefined) {
      await this.deps.focus(open.pane_id);
      return { workspace_id: open.workspace_id, pane_id: open.pane_id, outcome: "focused", agent_started: true };
    }
    const created = await this.deps.createTab(workspaceId, cwd);
    const launched = await this.deps.launch(created.pane_id, ["--resume", path]);
    if (launched.agent_started) this.started.set(path, created.pane_id);
    return { workspace_id: created.workspace_id, pane_id: created.pane_id, outcome: "started", ...launched };
  }
}
