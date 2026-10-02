import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OmoTask } from "../shared/protocol.ts";

/**
 * The background tasks one OmO session started, for the status line's list. OmO keeps one record
 * per `task` child in `<cwd>/.omo/senpi-task/tasks/st_*.json` and rewrites it as the child runs;
 * the parent is `parent_session_id`, the session id in the parent's file name. A record left
 * `running` by a host process that is gone reads as lost, as OmO itself would mark it. The
 * record also holds the child's prompt (`spawn_spec`) and its answer: neither leaves the server.
 * The list is asked for every few seconds while it is open, and a folder keeps every task OmO
 * ever ran (records of tens of KB): a record is parsed again only when its size or time changed,
 * and only what the list shows is kept. Only plain files are read (not a link, not a pipe). Newest
 * first by name (`st_` ids grow with time), and at most TASK_PARSE_BUDGET bytes parsed per call:
 * a folder of thousands is read over a few polls, and after that only what changed, so a task that
 * still runs under thousands of newer ones is found too.
 */
const MAX_RECORD_BYTES = 1024 * 1024;
const TASK_PARSE_BUDGET = 8 * 1024 * 1024;
const MAX_TASK_FILES = 50_000;

const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
const RUNNING = new Set(["running", "queued", "pending", "starting"]);
const ENDED = new Set(["completed", "failed", "cancelled", "lost"]);

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const time = (value: unknown): number => typeof value === "string" ? Date.parse(value) || 0 : 0;

/** What the list shows of a record, its host process told apart when asked: it can die any time. */
interface Kept { parent: unknown; hostPid: number | null; task: OmoTask | null }
const taskCache = new Map<string, { key: string; kept: Kept }>();

function keep(record: Row): Kept {
  return { parent: record["parent_session_id"], hostPid: typeof record["host_pid"] === "number" ? record["host_pid"] : null, task: task(record) };
}

function task(record: Row): OmoTask | null {
  const id = text(record["task_id"]);
  const raw = record["status"];
  if (id === null || typeof raw !== "string") return null;
  const status = RUNNING.has(raw) ? "running" : ENDED.has(raw) ? raw as OmoTask["status"] : null;
  if (status === null) return null;
  const stats = row(record["run_stats"]);
  return {
    id,
    title: text(record["task_summary"]) ?? text(record["description"]) ?? text(record["name"]) ?? id,
    category: text(record["category"]) ?? text(record["agent_type"]),
    model: text(row(record["resolved_model"])?.["display"]) ?? text(record["model"]),
    status,
    started_at: text(record["started_at"]) ?? text(record["created_at"]),
    ended_at: status === "running" ? text(record["updated_at"]) : text(record["terminal_at"]) ?? text(record["updated_at"]),
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
  const newest = names.filter((name) => name.startsWith("st_") && name.endsWith(".json")).sort().reverse().slice(0, MAX_TASK_FILES);
  let budget = TASK_PARSE_BUDGET;
  for (const name of newest) {
    const path = join(dir, name);
    let key: string;
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      key = `${stat.mtimeMs}:${stat.size}`;
      size = stat.size;
    } catch { continue; }
    let cached = taskCache.get(path);
    if (cached?.key !== key) {
      if (budget < size) continue; // read on a later poll
      budget -= size;
      let record: Row | null;
      try { record = row(JSON.parse(readFileSync(path, "utf8"))); } catch { continue; } // being written
      cached = { key, kept: record === null ? { parent: null, hostPid: null, task: null } : keep(record) };
      taskCache.set(path, cached);
    }
    const { parent, hostPid, task: kept } = cached.kept;
    if (parent !== sessionId || kept === null) continue;
    // its host died with it running: lost, as OmO itself marks it, and ended when last heard of
    const found: OmoTask = kept.status === "running" && hostPid !== null && !alive(hostPid) ? { ...kept, status: "lost" } : kept.status === "running" ? { ...kept, ended_at: null } : kept;
    // an ended task with no end time counts from its start; with neither, it is not known to be recent
    const at = time(found.ended_at) || time(found.started_at);
    if (found.status === "running") running.push(found);
    else if (at !== 0 && now - at <= RECENT_MS) ended.push(found);
  }
  if (taskCache.size > MAX_TASK_FILES) taskCache.clear();
  running.sort((a, b) => time(a.started_at) - time(b.started_at));
  ended.sort((a, b) => time(b.ended_at) - time(a.ended_at));
  return [...running, ...ended.slice(0, RECENT_LIMIT)];
}
