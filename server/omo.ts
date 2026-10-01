import { constants, fstatSync, closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";

const OMO_PROCESS = /(^|\/)omo(\.js)?$|\/omo-ai\//;
/** node and bun run a script: the program is then the script, the first word that is not a flag */
const JS_RUNTIME = /(^|\/)(node|nodejs|bun)$/;
/**
 * Only the program counts: argv[0] (omo's native binary, its SDK's claude), or the script a
 * JS runtime runs (`bun …/omo-ai/…/cli.js`, `node …/bin/omo`). An omo-ai path handed to another
 * program (`grep -q …/omo-ai/x`, `cat …/bin/omo`) is that program's argument, not omo. The word
 * is one path: a PATH list that names omo-ai's bin directory (`printf %s\n $PATH` in an rc
 * file) made a fresh shell pass for omo for a moment.
 */
export function isOmoProcess(argv: readonly string[]): boolean {
  const program = JS_RUNTIME.test(argv[0] ?? "") ? argv.slice(1).find((word) => !word.startsWith("-")) : argv[0];
  return program !== undefined && !program.includes(":") && OMO_PROCESS.test(program);
}

export interface OmoCandidate { path: string; id: string; createdAt: number | null }
export interface OmoRuntime {
  paneId: string;
  startedAt: number | null;
  /** Exact native session evidence, before considering a cwd/time inference. */
  paths: string[];
  ids: string[];
}

/** A session is never selected by mtime: tool activity is not evidence of pane ownership. */
export function selectOmoTranscript(paneId: string, candidates: OmoCandidate[], runtimes: OmoRuntime[], now = Date.now()): string | null {
  const direct = (runtime: OmoRuntime): OmoCandidate[] => candidates.filter((file) => runtime.paths.includes(file.path) || runtime.ids.includes(file.id));
  const target = runtimes.find((runtime) => runtime.paneId === paneId);
  if (!target) return null;
  const exact = direct(target);
  const claimed = new Set(runtimes.filter((runtime) => runtime !== target).flatMap((runtime) => direct(runtime).map((file) => file.path)));
  if (target.paths.length > 0 || target.ids.length > 0) {
    if (exact.length !== 1 || claimed.has(exact[0]!.path)) return null;
    // A launch ID can outlive /new. Without a current descriptor, a later unclaimed
    // session makes that hint ambiguous rather than pinning the old conversation.
    if (!target.paths.includes(exact[0]!.path) && target.startedAt !== null && candidates.some((file) =>
      file.path !== exact[0]!.path && !claimed.has(file.path) && file.createdAt !== null && file.createdAt > target.startedAt! + 1000 && file.createdAt <= now + 1000)) return null;
    return exact[0]!.path;
  }
  // A second process (or an unreadable peer) sharing cwd blocks inference entirely.
  if (runtimes.length !== 1 || target.startedAt === null) return null;
  const fresh = candidates.filter((file) => file.createdAt !== null && file.createdAt >= target.startedAt! - 1000 && file.createdAt <= now + 1000);
  return fresh.length === 1 ? fresh[0]!.path : null;
}

function candidate(path: string, root: string, cwd: string): OmoCandidate | null {
  let fd: number | undefined;
  try {
    const canonical = realpathSync(path);
    const inside = relative(realpathSync(root), canonical);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !canonical.endsWith(".jsonl")) return null;
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(4096);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const header = JSON.parse(bytes.subarray(0, length).toString("utf8").split("\n")[0]!);
    if (header?.type !== "session" || header.cwd !== cwd || typeof header.id !== "string") return null;
    const timestamp = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    return { path: canonical, id: header.id, createdAt: Number.isFinite(timestamp) ? timestamp : null };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const sessionDir = (cwd: string, home: string) => join(home, ".omo", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);

// A holder's start is floored to the second (as `ps -o lstart`), ours is in clock ticks.
const HOLDER_START_TOLERANCE_MS = 3000;

/**
 * omo keeps no descriptor on its session file, but every process with a session open
 * publishes <session dir>/session-holders/<encoded id>/<pid>.json and removes it on
 * release (/new, /resume, exit). A crashed process leaves its record behind, so one
 * counts only for the live pid it names and, where our start time is readable, only
 * if it started when that pid did: a reused pid starts later.
 */
export function heldSessionIds(dir: string, pid: number, startedAt: number | null): string[] {
  const holders = join(dir, "session-holders");
  let names: string[] = [];
  try { names = readdirSync(holders); } catch { return []; }
  const ids: string[] = [];
  for (const name of names.slice(0, 4096)) {
    try {
      const record = JSON.parse(readFileSync(join(holders, name, `${pid}.json`), "utf8"));
      if (record?.pid !== pid) continue;
      if (startedAt !== null && !(typeof record.processStartedAtMs === "number" && Math.abs(record.processStartedAtMs - startedAt) <= HOLDER_START_TOLERANCE_MS)) continue;
      ids.push(decodeURIComponent(name));
    } catch { /* this pid holds nothing here, or the record is unreadable */ }
  }
  return ids;
}

/** Bounded, canonical store reads; exact descriptor paths can live outside the cwd slug. */
export function omoCandidates(cwd: string, home: string, exactPaths: string[] = []): OmoCandidate[] {
  const root = join(home, ".omo", "agent", "sessions");
  const dir = sessionDir(cwd, home);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* only explicit evidence may remain */ }
  // Never choose a subset when the directory is too large to inspect safely.
  const paths = new Set(exactPaths);
  if (names.length <= 4096) for (const name of names) if (name.endsWith(".jsonl")) paths.add(join(dir, name));
  const found = new Map<string, OmoCandidate>();
  for (const path of paths) {
    const file = candidate(path, root, cwd);
    if (file) found.set(file.path, file);
  }
  return [...found.values()];
}

function resumedIds(argv: string[]): string[] {
  const result: string[] = [];
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!;
    const id = word.startsWith("--session-id=") ? word.slice(13) : word === "--session-id" ? argv[at + 1] : undefined;
    if (id && /^[A-Za-z0-9_-]{8,128}$/.test(id)) result.push(id);
  }
  return result;
}

/** Same-cwd peers are inspected even when herdr calls omo's SDK child `claude`. */
export async function omoTranscriptForPane(paneId: string, cwd: string, panes: HerdrPane[], home = process.env["HOME"] ?? ""): Promise<string | null> {
  const runtimes: OmoRuntime[] = [];
  // Only an open file in the session store is evidence: omo also holds its background
  // tasks' logs (<cwd>/.omo/senpi-task/logs/*.jsonl) open, and one of those pinned the
  // pane to a path no candidate matches, so the chat lost the transcript mid-session.
  let store = join(home, ".omo", "agent", "sessions");
  try { store = realpathSync(store); } catch { /* no store yet: no descriptor can be in it */ }
  const dir = sessionDir(cwd, home);
  const held = new Map<string, string[]>();
  await Promise.all(panes.filter((pane) => pane.cwd === cwd).map(async (pane) => {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: pane.pane_id }).catch(() => null);
    if (!info?.process_info?.foreground_processes) { runtimes.push({ paneId: pane.pane_id, startedAt: null, paths: [], ids: [] }); return; }
    const processes = (info.process_info?.foreground_processes ?? []).filter((process) => isOmoProcess(process.argv ?? []));
    if (processes.length === 0) return;
    const starts = processes.map((process) => processStartedAt(process.pid));
    const paths: string[] = [];
    const ids: string[] = [];
    held.set(pane.pane_id, processes.flatMap((process, index) => heldSessionIds(dir, process.pid, starts[index] ?? null)));
    for (const process of processes) {
      ids.push(...resumedIds(process.argv ?? []));
      let descriptors: string[] = [];
      try { descriptors = readdirSync(`/proc/${process.pid}/fd`).slice(0, 1024); } catch { /* unavailable on macOS */ }
      for (const descriptor of descriptors) {
        try {
          const path = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
          if (path.endsWith(".jsonl") && path.startsWith(store + sep)) paths.push(path);
        } catch { /* descriptor closed */ }
      }
    }
    const session = pane.agent_session;
    if (session?.agent === "omo" && session.value) {
      if (session.kind === "path") paths.push(session.value);
      if (session.kind === "id") ids.push(session.value);
    }
    runtimes.push({ paneId: pane.pane_id, startedAt: starts.every((start) => start !== null) ? Math.min(...(starts as number[])) : null, paths, ids });
  }));
  const files = omoCandidates(cwd, home, runtimes.flatMap((runtime) => runtime.paths));
  // Match canonical candidates even when /proc names a symlink into the store.
  for (const runtime of runtimes) runtime.paths = runtime.paths.flatMap((path) => { try { return [realpathSync(path)]; } catch { return []; } });
  for (const runtime of runtimes) {
    const ids = held.get(runtime.paneId) ?? [];
    const current = files.filter((file) => ids.includes(file.id)).map((file) => file.path);
    if (current.length === 0) continue;
    // The session held now outranks a launch --session-id and herdr's session path or id,
    // which /new leaves behind.
    runtime.paths = current;
    runtime.ids = [];
  }
  return selectOmoTranscript(paneId, files, runtimes);
}
