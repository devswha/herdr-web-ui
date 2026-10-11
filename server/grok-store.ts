/** Exact Grok session binding on the machine that owns the pane. */
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { herdrRpc, herdrSocketPath } from "./herdr/client.ts";
import { recentProcessTable, runsAgent } from "./gjc-runtime.ts";
import { darwinProcessStart } from "./process-start.ts";
import { windowsArgv, type ProcessRow } from "./windows-processes.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
export const GROK_BINDING_TTL_NS = 15_000_000_000n;
// Bun's hrtime is process-relative; persisted observations need a shared clock.
export const grokReportTime = (): bigint => BigInt(Date.now()) * 1_000_000n;
export interface GrokBinding {
  version: 1; socket: string; pane: string; pid: number; started: string;
  home: string; session: string; transcript: string; observed_ns: string;
}

/** Reuse the native process-start checks used by the other transcript readers. */
export async function grokProcessIdentity(pid: number, rows?: readonly ProcessRow[]): Promise<{ started: string; parent: number } | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === "win32") {
      const row = rows?.find((p) => p.pid === pid);
      return row?.started ? { started: `win32:${row.started}`, parent: row.parent } : null;
    }
    if (process.platform === "darwin") {
      const started = await darwinProcessStart(pid);
      const ps = Bun.spawn(["/bin/ps", "-o", "ppid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
      const parent = Number((await new Response(ps.stdout).text()).trim());
      return started && await ps.exited === 0 && Number.isSafeInteger(parent) && parent > 0 ? { started, parent } : null;
    }
    if (process.platform !== "linux") return null;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    if (!/^\d+$/.test(fields[19] ?? "")) return null;
    return { started: `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`, parent: Number(fields[1]) };
  } catch { return null; }
}

/** Beside the Herdr socket/Windows marker: the reader need not discover GROK_HOME
 * before it can find the helper's process-bound observation. */
export function grokBindingFile(socket: string, pane: string): string | null {
  if (!isAbsolute(socket)) return null;
  const key = createHash("sha256").update(`${socket}\0${pane}`).digest("hex");
  return join(dirname(socket), "grok-chat", `${key}.json`);
}

/** Windows uses the containing user directory's ACL; POSIX also checks uid/mode. */
export const grokPrivateFile = (stat: Stats): boolean => !stat.isSymbolicLink()
  && (process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0));

export interface GrokProcessInfo { shell_pid?: number | null; foreground_processes?: { pid: number; argv?: string[] }[] }
const GROK_EXECUTABLE = /(^|[\\/])grok(?:-\d[^\\/]*)?(?:\.exe|\.[cm]?js)?$/i;
export function grokPaneProcesses(info: GrokProcessInfo, rows: readonly ProcessRow[] = [], platform = process.platform): { pid: number }[] {
  if (platform !== "win32") return (info.foreground_processes ?? []).filter((p) => runsAgent(p.argv ?? [], GROK_EXECUTABLE));
  if (!info.shell_pid) return [];
  const found: { pid: number }[] = [], pending = [info.shell_pid], seen = new Set<number>();
  while (pending.length) {
    const parent = pending.pop()!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const row of rows) {
      if (row.parent !== parent || seen.has(row.pid)) continue;
      const argv = windowsArgv(row.commandLine ?? "");
      if (row.path) argv[0] = row.path;
      if (runsAgent(argv, GROK_EXECUTABLE)) found.push({ pid: row.pid });
      else pending.push(row.pid);
    }
  }
  return found;
}

/** undefined: reporter never installed here; null: its evidence exists but is unusable.
 * A failed/expired reporter must never silently downgrade to the old hook's stale ID. */
export function readGrokBinding(file: string, expected: Omit<GrokBinding, "version" | "transcript" | "observed_ns" | "home"> & { home?: string }, now = grokReportTime()): string | null | undefined {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || !grokPrivateFile(stat) || stat.size > 4096) return null;
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.version !== 1 || typeof value.observed_ns !== "string" || !/^\d{1,30}$/.test(value.observed_ns)) return null;
    const age = now - BigInt(value.observed_ns);
    if (age < 0 || age > GROK_BINDING_TTL_NS) return null;
    for (const [key, field] of Object.entries(expected)) if (value[key] !== field) return null;
    if (typeof value.transcript !== "string" || typeof value.home !== "string" || !isAbsolute(value.home)) return null;
    const store = realpathSync(join(value.home, "sessions"));
    const path = realpathSync(value.transcript);
    const parts = relative(store, path).split(sep);
    return path === value.transcript && inside(store, path) && parts.length === 3
      && parts[1] === expected.session && parts[2] === "updates.jsonl" && statSync(path).isFile() ? path : null;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" && !statSync(file, { throwIfNoEntry: false }) ? undefined : null; }
}
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!isAbsolute(home) || !SESSION.test(session)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const groups = opendirSync(store);
    let found: string | null = null;
    let count = 0;
    try {
      for (let group = groups.readSync(); group; group = groups.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (!group.isDirectory()) continue;
        const candidate = join(store, group.name, session, "updates.jsonl");
        try {
          const path = realpathSync(candidate);
          // Reject a link into another session as well as links outside the store.
          if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
          if (found !== null) return null;
          found = path;
        } catch { /* no matching file in this group */ }
      }
    } finally { groups.closeSync(); }
    return found;
  } catch { return null; }
}

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/** Grok 1.0.50 holds the active events.jsonl and can retain earlier sessions. Its /resume
 * picker does NOT refresh Herdr's SessionStart identity. Multiple held sessions therefore
 * make the current one unknowable; do not select the newest or most recently written. */
export function grokHeldSession(pid: number, home: string): string | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Set<string>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > 4096) return null;
        let target: string;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd.name}`); } catch { continue; }
        if (basename(target) !== "events.jsonl" || !inside(store, target)) continue;
        const parts = relative(store, target).split(sep);
        if (parts.length !== 3 || !SESSION.test(parts[1]!)) continue;
        if (realpathSync(target) !== target) return null;
        sessions.add(dirname(target));
      }
    } finally { fds.closeSync(); }
    return sessions.size === 1 ? [...sessions][0]! : null;
  } catch { return null; }
}

export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  try {
    const info = await herdrRpc<{ process_info?: GrokProcessInfo }>("pane.process_info", { pane_id: pane.pane_id });
    const rows = process.platform === "win32" ? await recentProcessTable() : undefined;
    const processes = grokPaneProcesses(info.process_info ?? {}, rows);
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    const environment = process.platform === "linux" ? readFileSync(`/proc/${owner.pid}/environ`, "utf8") : null;
    const home = configuredHome ?? (environment === null ? null : grokHomeFromEnvironment(environment));
    if (environment !== null && !home) return null;
    const identity = await grokProcessIdentity(owner.pid, rows);
    const socket = realpathSync(herdrSocketPath());
    const bindingFile = grokBindingFile(socket, pane.pane_id);
    if (!identity || !bindingFile) return null;
    const binding = readGrokBinding(bindingFile, { socket, pane: pane.pane_id, pid: owner.pid, started: identity.started, ...(home ? { home: realpathSync(home) } : {}), session: session.value });
    if (binding !== undefined) return binding;
    // The held-set invariant was observed on this exact native build, including a
    // resume into a session the process had never visited. Unknown builds need the
    // status-line reporter; argv alone does not attest the version.
    if (process.platform !== "linux" || !home || basename(readlinkSync(`/proc/${owner.pid}/exe`)) !== "grok-1.0.50-linux-x86_64") return null;
    const held = grokHeldSession(owner.pid, home);
    const path = grokTranscriptPath(home, session.value);
    return held !== null && path !== null && dirname(path) === held ? path : null;
  } catch { return null; }
}
