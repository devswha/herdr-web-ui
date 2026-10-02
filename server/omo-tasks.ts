import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OmoRun, OmoRunNode, OmoTask } from "../shared/protocol.ts";

/**
 * The background tasks one OmO session started, for the status line's list. OmO keeps one record
 * per `task` child in `<cwd>/.omo/senpi-task/tasks/st_*.json` and rewrites it as the child runs;
 * the parent is `parent_session_id`, the session id in the parent's file name. A record left
 * `running` by a host process that is gone reads as lost, as OmO itself would mark it. The
 * record also holds the child's prompt (`spawn_spec`) and its answer: neither leaves the server.
 */

const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
const RUNNING = new Set(["running", "queued", "pending", "starting"]);
const ENDED = new Set(["completed", "failed", "cancelled", "lost"]);

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const time = (value: unknown): number => typeof value === "string" ? Date.parse(value) || 0 : 0;

function task(record: Row, alive: (pid: number) => boolean): OmoTask | null {
  const id = text(record["task_id"]);
  const raw = record["status"];
  if (id === null || typeof raw !== "string") return null;
  const dead = typeof record["host_pid"] === "number" && !alive(record["host_pid"]);
  const status = RUNNING.has(raw) ? (dead ? "lost" : "running") : ENDED.has(raw) ? raw as OmoTask["status"] : null;
  if (status === null) return null;
  const stats = row(record["run_stats"]);
  return {
    id,
    title: text(record["task_summary"]) ?? text(record["description"]) ?? text(record["name"]) ?? id,
    category: text(record["category"]) ?? text(record["agent_type"]),
    model: text(row(record["resolved_model"])?.["display"]) ?? text(record["model"]),
    status,
    started_at: text(record["started_at"]) ?? text(record["created_at"]),
    ended_at: status === "running" ? null : text(record["terminal_at"]) ?? text(record["updated_at"]),
    turns: count(stats?.["turns"]),
    tool_calls: count(stats?.["tool_calls"]),
    tokens: count(stats?.["total_tokens"]),
  };
}

/** Running tasks first (oldest first), then up to ten that ended in the last day (newest first). */
export function omoTasks(cwd: string, sessionId: string, alive: (pid: number) => boolean, now = Date.now()): OmoTask[] {
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const running: OmoTask[] = [];
  const ended: OmoTask[] = [];
  for (const name of names.slice(0, 2048)) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    let record: Row | null;
    try { record = row(JSON.parse(readFileSync(join(dir, name), "utf8"))); } catch { continue; } // being written
    if (record === null || record["parent_session_id"] !== sessionId) continue;
    const found = task(record, alive);
    if (found === null) continue;
    // a task whose host died has no end time: it counts from its start, and with neither, it shows
    const at = time(found.ended_at) || time(found.started_at);
    if (found.status === "running") running.push(found);
    else if (at === 0 || now - at <= RECENT_MS) ended.push(found);
  }
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => time(b.ended_at) - time(a.ended_at));
  return [...running, ...ended.slice(0, RECENT_LIMIT)];
}

/**
 * The workflows (DAG runs) the session started: OmO checkpoints each run to
 * `<cwd>/.omo/senpi-task/dag/runs/dag_*.json` (`parentSessionId`, nodes with `state`, `waves`),
 * rewriting the whole file at each step. The files carry every node's prompt and output, up to a
 * megabyte each, so a file is parsed only when its size or time changed, and one untouched for a
 * day is not opened at all: OmO left it, or a run it never finished. Prompts and outputs stay here.
 */
const RUN_LIMIT = 5;
const NODE_STATES = new Set(["pending", "scheduled", "running", "completed", "failed", "skipped", "cancelled"]);
const RUN_STATES = new Set(["running", "completed", "failed", "cancelled"]);
const runCache = new Map<string, { key: string; parent: string | null; run: OmoRun | null }>();

function parseRun(record: Row): { parent: string | null; run: OmoRun | null } {
  const parent = typeof record["parentSessionId"] === "string" ? record["parentSessionId"] : null;
  const id = text(record["runId"]);
  const status = record["status"];
  if (id === null || typeof status !== "string" || !RUN_STATES.has(status) || !Array.isArray(record["nodes"])) return { parent, run: null };
  const nodes = new Map<string, OmoRunNode>();
  for (const value of record["nodes"]) {
    const node = row(value);
    const nodeId = text(node?.["id"]);
    const state = node?.["state"];
    if (node === null || nodeId === null || typeof state !== "string" || !NODE_STATES.has(state)) continue;
    nodes.set(nodeId, { id: nodeId, label: text(node["label"]) ?? nodeId, state: state as OmoRunNode["state"], error: state === "failed" ? text(row(node["error"])?.["message"]) : null });
  }
  const waves: OmoRunNode[][] = [];
  const placed = new Set<string>();
  for (const value of Array.isArray(record["waves"]) ? record["waves"] : []) {
    const ids = row(value)?.["nodeIds"];
    const wave = (Array.isArray(ids) ? ids : []).flatMap((nodeId) => {
      const node = typeof nodeId === "string" && !placed.has(nodeId) ? nodes.get(nodeId) : undefined;
      if (node === undefined) return [];
      placed.add(node.id);
      return [node];
    });
    if (wave.length > 0) waves.push(wave);
  }
  const rest = [...nodes.values()].filter((node) => !placed.has(node.id));
  if (rest.length > 0) waves.push(rest);
  return {
    parent,
    run: {
      id,
      name: text(record["name"]) ?? text(record["runKey"]) ?? id,
      status: status as OmoRun["status"],
      started_at: text(record["startedAt"]) ?? text(record["createdAt"]),
      ended_at: status === "running" ? null : text(record["completedAt"]) ?? text(record["updatedAt"]),
      waves,
    },
  };
}

/** Running workflows first (oldest first), then up to five that ended in the last day (newest first). */
export function omoRuns(cwd: string, sessionId: string, now = Date.now()): OmoRun[] {
  const dir = join(cwd, ".omo", "senpi-task", "dag", "runs");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const running: OmoRun[] = [];
  const ended: OmoRun[] = [];
  for (const name of names.slice(0, 512)) {
    if (!name.startsWith("dag_") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    let key: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || now - stat.mtimeMs > RECENT_MS) continue;
      key = `${stat.mtimeMs}:${stat.size}`;
    } catch { continue; }
    let cached = runCache.get(path);
    if (cached?.key !== key) {
      let record: Row | null;
      try { record = row(JSON.parse(readFileSync(path, "utf8"))); } catch { continue; } // being rewritten
      cached = { key, ...(record === null ? { parent: null, run: null } : parseRun(record)) };
      runCache.set(path, cached);
    }
    if (cached.parent !== sessionId || cached.run === null) continue;
    (cached.run.status === "running" ? running : ended).push(cached.run);
  }
  if (runCache.size > 2048) runCache.clear();
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => time(b.ended_at) - time(a.ended_at));
  return [...running, ...ended.slice(0, RUN_LIMIT)];
}
