/**
 * The status of an OmO pane, read from OmO's own records.
 *
 * herdr reports nothing for one: OmO runs its claude child without the user's settings, so
 * herdr's hook never runs in it, and the pane reads `claude/idle` through a whole turn with no
 * status event (#286: three panes watched for three minutes, no frame). The sidebar never said
 * RUN, a message sent meanwhile was not held, and no done alert came.
 *
 * OmO appends to the session file of the session the pane holds (omo.ts finds it) as a turn
 * goes: a turn is running after a user message, a tool result, an assistant message that
 * stopped for a tool, or one of the runtime's own messages that start a turn (a finished
 * background task, a monitor, a goal continuation); it is over after an assistant message that
 * stopped for good. Measured over 40 session files: each of 492 such runtime messages written at
 * rest was followed by an assistant message, a median of 5 s later, so the message itself is the
 * start. Nothing of OmO's or Claude's is installed or changed for this: files are read.
 *
 * The status replaces herdr's for the pane before CompletionTracker sees it, in status events and
 * in snapshots alike, under the one identity `omo`: herdr has named such a pane `pi` and `claude`
 * by turns, and a finish is matched by identity. A pane whose session cannot be told keeps
 * herdr's status.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

/** runtime messages that start a turn nobody typed */
const TURN_STARTS = new Set([
  "goal-continuation", "omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification",
  "senpi-codemode:notification", "senpi.todo-owed",
]);

/** The end of a session file is enough: the last message decides, and a file runs to megabytes. */
const TAIL_BYTES = 256 * 1024;

/**
 * Whether the turn at the end of this session text is running. null when the text holds nothing
 * that tells (a tail cut inside one long record).
 */
export function omoTurnStatus(text: string): "working" | "idle" | null {
  let status: "working" | "idle" | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"type":"message"') && !line.startsWith('{"type":"custom_message"')) continue;
    let entry: { type?: unknown; customType?: unknown; message?: { role?: unknown; stopReason?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "custom_message") {
      if (typeof entry.customType === "string" && TURN_STARTS.has(entry.customType)) status = "working";
      continue;
    }
    const role = entry.message?.role;
    if (role === "assistant") status = entry.message?.stopReason === "toolUse" ? "working" : "idle";
    else if (role === "user" || role === "toolResult") status = "working";
  }
  return status;
}

/** The last bytes of a file and its size, or null when it cannot be read. A first line cut by the window is dropped. */
export function readTail(path: string, bytes = TAIL_BYTES): { size: number; text: string } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - from);
    const text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from)).toString("utf8");
    return { size, text: from === 0 ? text : text.slice(text.indexOf("\n") + 1) };
  } catch { return null; }
  finally { closeSync(fd); }
}

/** `<timestamp>_<session id>.jsonl` */
export function omoSessionId(path: string): string | null {
  return basename(path).match(/_([A-Za-z0-9-]{8,128})\.jsonl$/)?.[1] ?? null;
}

/**
 * How many background tasks of a session are running: OmO keeps one record per `task` child in
 * `<cwd>/.omo/senpi-task/tasks/`, with the session that started it. A record left `running` by a
 * host process that is gone is not counted.
 */
export function omoBackgroundTasks(cwd: string, sessionId: string, alive: (pid: number) => boolean = processAlive): number {
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let running = 0;
  for (const name of names.slice(0, 2048)) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as { status?: unknown; parent_session_id?: unknown; host_pid?: unknown };
      if (record.status !== "running" || record.parent_session_id !== sessionId) continue;
      if (typeof record.host_pid === "number" && !alive(record.host_pid)) continue;
      running += 1;
    } catch { /* being written, or not a record */ }
  }
  return running;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface OmoStatusDeps {
  /** does this pane run OmO, whatever herdr calls it */
  runsOmo: (paneId: string) => Promise<boolean>;
  /** the session file the pane holds, or null when it cannot be told */
  transcript: (paneId: string, cwd: string, panes: HerdrPane[]) => Promise<string | null>;
  snapshot: () => Promise<SessionSnapshot>;
  /** a pane's turn started or ended, or its background tasks changed */
  onChange: (paneId: string, status: AgentStatus, background: number) => void;
  read?: (path: string) => { size: number; text: string } | null;
  background?: (cwd: string, sessionId: string) => number;
  /** how often the session files are looked at, and the panes found anew */
  pollMs?: number;
  refreshMs?: number;
  now?: () => number;
}

interface Tracked { path: string | null; cwd: string; size: number; status: "working" | "idle"; background: number }

export class OmoStatus {
  /** every pane that runs OmO; those whose session is known carry a status */
  private readonly panes = new Map<string, Tracked>();
  private refreshedAt = -Infinity;
  private refreshedFor = "";
  private refreshing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private readonly read: NonNullable<OmoStatusDeps["read"]>;
  private readonly background: NonNullable<OmoStatusDeps["background"]>;
  private readonly now: () => number;
  private readonly refreshMs: number;

  constructor(private readonly deps: OmoStatusDeps) {
    this.read = deps.read ?? readTail;
    this.background = deps.background ?? omoBackgroundTasks;
    this.now = deps.now ?? Date.now;
    this.refreshMs = deps.refreshMs ?? 5000;
  }

  /** Watches with no browser connected too: web push depends on it. */
  start(): void {
    if (this.timer !== null) return;
    const pollMs = this.deps.pollMs ?? 1000;
    const every = Math.max(1, Math.round(this.refreshMs / pollMs));
    this.timer = setInterval(() => {
      this.poll();
      if (++this.ticks % every === 0) void this.deps.snapshot().then((snapshot) => this.refresh(snapshot.panes)).catch(() => undefined);
    }, pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** herdr's status for this pane is replaced: its events say nothing true. */
  tracks(paneId: string): boolean {
    return this.panes.get(paneId)?.path != null;
  }

  backgroundOf(paneId: string): number {
    return this.panes.get(paneId)?.background ?? 0;
  }

  /**
   * Finds the OmO panes of a snapshot and their session files. Asked of herdr at most once per
   * `refreshMs` while the panes stay the same: each pane costs a process lookup.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    const key = panes.map((pane) => `${pane.pane_id}\0${pane.agent ?? ""}\0${pane.cwd ?? ""}`).join("\n");
    if (key === this.refreshedFor && this.now() - this.refreshedAt < this.refreshMs) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const candidates = panes.filter((pane) => !pane.agent || pane.agent === "pi" || pane.agent === "claude" || pane.agent === "omo");
      const found = new Map<string, Tracked>();
      await Promise.all(candidates.map(async (pane) => {
        if (!await this.deps.runsOmo(pane.pane_id).catch(() => false)) return;
        const cwd = pane.cwd ?? "";
        const path = cwd ? await this.deps.transcript(pane.pane_id, cwd, panes).catch(() => null) : null;
        const before = this.panes.get(pane.pane_id);
        found.set(pane.pane_id, before && before.path === path ? before : { path, cwd, size: -1, status: "idle", background: 0 });
      }));
      this.panes.clear();
      for (const [paneId, tracked] of found) this.panes.set(paneId, tracked);
      this.refreshedFor = key;
      this.refreshedAt = this.now();
      // a pane found anew is read before any snapshot shows it, and tells nobody: the snapshot does
      this.poll(false);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Reads the session files that grew; a turn that started or ended is told. */
  poll(tell = true): void {
    for (const [paneId, tracked] of this.panes) {
      if (tracked.path === null) continue;
      const tail = this.read(tracked.path);
      if (tail === null) continue;
      const sessionId = omoSessionId(tracked.path);
      const background = sessionId ? this.background(tracked.cwd, sessionId) : 0;
      let status = tracked.status;
      if (tail.size !== tracked.size) {
        status = omoTurnStatus(tail.text) ?? tracked.status;
        tracked.size = tail.size;
      }
      const changed = status !== tracked.status || background !== tracked.background;
      tracked.status = status;
      tracked.background = background;
      if (changed && tell) this.deps.onChange(paneId, status, background);
    }
  }

  /**
   * A snapshot with OmO's own status in place of herdr's, under the identity `omo`, for the
   * panes whose session is known. This is what CompletionTracker settles.
   */
  apply<T extends { panes: HerdrPane[]; agents?: SessionSnapshot["agents"] }>(snapshot: T): T {
    const status = (paneId: string) => { const tracked = this.panes.get(paneId); return tracked && tracked.path !== null ? tracked.status : null; };
    if (!snapshot.panes.some((pane) => status(pane.pane_id) !== null)) return snapshot;
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => status(pane.pane_id) !== null ? { ...pane, agent: "omo", agent_status: status(pane.pane_id)! } : pane),
      ...(snapshot.agents ? { agents: snapshot.agents.map((agent) => status(agent.pane_id) !== null ? { ...agent, agent: "omo", agent_status: status(agent.pane_id)! } : agent) } : {}),
    };
  }

  /** The name shown for every OmO pane, also one whose session is not known. */
  label(snapshot: SessionSnapshot): SessionSnapshot {
    if (!snapshot.panes.some((pane) => this.panes.has(pane.pane_id))) return snapshot;
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => this.panes.has(pane.pane_id) ? { ...pane, agent: "omo" } : pane),
      agents: snapshot.agents.map((agent) => this.panes.has(agent.pane_id) ? { ...agent, agent: "omo" } : agent),
    };
  }
}
