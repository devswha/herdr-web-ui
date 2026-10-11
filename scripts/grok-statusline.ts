/** Opt-in Grok status-line reporter. Does not install or edit any configuration.
 * Usage: bun scripts/grok-statusline.ts [-- <existing status-line command and args>]
 * SQLite serializes writers across platforms. The original command receives unchanged stdin.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { grokBindingFile, grokHomeFromEnvironment, grokPaneProcesses, grokPrivateFile, grokProcessIdentity, grokReportTime, GROK_BINDING_TTL_NS, type GrokBinding, type GrokProcessInfo } from "../server/grok-store.ts";
import { HerdrError, herdrRpc } from "../server/herdr/client.ts";
import { windowsProcessTable, type ProcessRow } from "../server/windows-processes.ts";
import type { HerdrPane } from "../shared/protocol.ts";

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const HEARTBEAT_NS = 5_000_000_000n;
const REPORT_BUDGET_MS = process.platform === "win32" ? 5000 : 1000;
const RPC_BUDGET_MS = 200;

export function statuslineIdentity(value: unknown): { session: string; transcript: string } | null {
  if (value === null || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload.session_id !== "string" || !UUID.test(payload.session_id) || typeof payload.transcript_path !== "string") return null;
  return { session: payload.session_id, transcript: payload.transcript_path };
}

/** A shell or pipeline can sit between Grok and the wrapper. Never use the pane's
 * foreground PID as a substitute for actual ancestry: an old callback can outlive it. */
async function ancestor(candidates: readonly { pid: number }[], rows?: readonly ProcessRow[]): Promise<{ pid: number; started: string; environment: string } | null> {
  let pid = process.ppid;
  for (let depth = 0; depth < 8; depth++) {
    const identity = await grokProcessIdentity(pid, rows);
    if (!identity) return null;
    if (candidates.some((p) => p.pid === pid)) {
      const environment = process.platform === "linux" ? readFileSync(`/proc/${pid}/environ`, "utf8")
        : Object.entries(process.env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join("\0");
      return { pid, started: identity.started, environment };
    }
    if (identity.parent === pid) return null;
    pid = identity.parent;
  }
  return null;
}

function previous(file: string): GrokBinding | null {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || !grokPrivateFile(stat) || stat.size > 4096) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch { return null; }
}

export function needsGrokReport(before: GrokBinding | null, next: GrokBinding): boolean {
  if (!before || before.version !== 1 || typeof before.observed_ns !== "string" || !/^\d{1,30}$/.test(before.observed_ns)) return true;
  const elapsed = BigInt(next.observed_ns) - BigInt(before.observed_ns);
  if (elapsed <= 0) return false;
  if (before.started !== next.started || before.pid !== next.pid) return true;
  return before.session !== next.session || before.transcript !== next.transcript || elapsed >= HEARTBEAT_NS;
}

function save(file: string, value: GrokBinding): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  finally { try { unlinkSync(temp); } catch { /* renamed or not created */ } }
}

/** SQLite releases the lock even when a callback is killed; no platform utility or
 * stale lock-file reclamation is needed. A competing callback skips this tick. */
export async function withGrokReportLock(file: string, run: () => Promise<void>): Promise<void> {
  closeSync(openSync(file, "a", 0o600));
  const stat = lstatSync(file);
  if (!stat.isFile() || !grokPrivateFile(stat)) return;
  const db = new Database(file);
  try {
    try { db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch { return; }
    try { await run(); } finally { db.exec("ROLLBACK"); }
  } finally { db.close(); }
}

async function report(input: string, observed: string): Promise<void> {
  if (!["linux", "darwin", "win32"].includes(process.platform) || process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_PANE_ID) return;
  if (!/^\d{1,30}$/.test(observed)) return;
  const age = grokReportTime() - BigInt(observed);
  if (age < 0 || age > GROK_BINDING_TTL_NS) return;
  const deadline = Number(BigInt(observed) / 1_000_000n) + REPORT_BUDGET_MS;
  const current = () => Date.now() <= deadline && grokReportTime() >= BigInt(observed);
  const payload = statuslineIdentity(JSON.parse(input));
  if (!payload) return;
  const socket = realpathSync(process.env.HERDR_SOCKET_PATH);
  const pane = process.env.HERDR_PANE_ID;
  const [rows, info] = await Promise.all([
    process.platform === "win32" ? windowsProcessTable(2000) : undefined,
    herdrRpc<{ process_info?: GrokProcessInfo }>("pane.process_info", { pane_id: pane }, socket, RPC_BUDGET_MS),
  ]);
  const owner = await ancestor(grokPaneProcesses(info.process_info ?? {}, rows), rows);
  if (!owner || !current()) return;
  const homeValue = grokHomeFromEnvironment(owner.environment);
  if (!homeValue) return;
  const home = realpathSync(homeValue);
  const file = grokBindingFile(socket, pane);
  if (!file) return;
  const transcript = realpathSync(payload.transcript);
  // The native payload must name the store inherited by this Grok callback.
  const child = relative(realpathSync(join(home, "sessions")), transcript);
  const parts = child.split(sep);
  if (isAbsolute(child) || parts.length !== 3 || parts[0] === ".." || parts[1] !== payload.session || parts[2] !== "updates.jsonl" || !statSync(transcript).isFile()) return;
  const next: GrokBinding = { version: 1, socket, pane, pid: owner.pid, started: owner.started, home, session: payload.session, transcript, observed_ns: observed };
  if (!needsGrokReport(previous(file), next) || !needsGrokReport(previous(`${file}.attempt`), next)) return;
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || !grokPrivateFile(directoryStat)) return;
  await withGrokReportLock(`${file}.lock`, async () => {
    if (!current() || !needsGrokReport(previous(file), next) || !needsGrokReport(previous(`${file}.attempt`), next)) return;
    save(`${file}.attempt`, next);
    const alive = async () => (await grokProcessIdentity(owner.pid,
      process.platform === "win32" ? await windowsProcessTable(Math.max(1, deadline - Date.now())) : rows))?.started === owner.started;
    if (!await alive() || !current()) return;
    // Herdr 0.9.3 accepts an ID switch only for "new", including a resume.
    // A future documented refresh/switch operation should replace this workaround.
    try {
      await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:grok", agent: "grok", seq: Date.now() * 1_000_000, agent_session_id: next.session, session_start_source: "new" }, socket, Math.max(1, Math.min(RPC_BUDGET_MS, deadline - Date.now())), current);
    } catch (error) {
      // A timeout can follow an applied mutation. Confirm, without resending it.
      if (!(error instanceof HerdrError) || error.code !== "timeout") throw error;
    }
    while (current()) {
      try {
        const { pane: verified } = await herdrRpc<{ pane: HerdrPane }>("pane.get", { pane_id: pane }, socket, Math.max(1, Math.min(RPC_BUDGET_MS, deadline - Date.now())));
        if (verified.agent === "grok" && verified.agent_session?.value === next.session && verified.agent_session.source === "herdr:grok") {
          if (await alive() && current()) save(file, next);
          return;
        }
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "timeout") throw error;
      }
      if (Date.now() + 25 > deadline) return;
      await Bun.sleep(25);
    }
  });
}

if (import.meta.main) {
  const observed = grokReportTime().toString();
  const command = process.argv.slice(2);
  if (command[0] === "--") command.shift();
  let original: ReturnType<typeof Bun.spawn<"pipe", "inherit", "inherit">> | undefined;
  let status = 0;
  if (command.length > 0) {
    try { original = Bun.spawn(command, { stdin: "pipe", stdout: "inherit", stderr: "inherit" }); }
    catch { status = 1; }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = Bun.stdin.stream().getReader();
  for (;;) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    if (original) { try { original.stdin.write(chunk); await original.stdin.flush(); } catch { /* command closed stdin */ } }
    size += chunk.byteLength;
    if (size <= 256 * 1024) chunks.push(Buffer.from(chunk)); else chunks.length = 0;
  }
  original?.stdin.end();
  const reporting = size <= 256 * 1024
    ? report(Buffer.concat(chunks).toString("utf8"), observed).catch(() => {})
    : Promise.resolve();
  if (original) status = await original.exited;
  await reporting;
  process.exitCode = status;
}
