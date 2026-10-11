import type { HerdrPane, PlanActivity, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { lineNotifications, plain, readLines, remember } from "./claude-subagents.ts";

/**
 * The plan an agent keeps for its session, read back from the session's transcript, for the
 * sidebar's progress and the plan panel. Nothing new is asked of the agent: Claude Code's task
 * list (`TaskCreate`/`TaskUpdate`, whose `blockedBy` gives the flow) and Codex's `update_plan`
 * checklist are already written there.
 *
 * Claude: a task is taken when its tool call is answered without an error, with the id Claude
 * gave it. Claude empties its list once every task in it is done, and so does this: the first
 * task created after that starts a new plan. A teammate of an agent team that changes a task
 * writes that in its own transcript, which is not read here.
 *
 * Codex: each explicit `update_plan` call sends the whole checklist, so the last one is the plan.
 * Code inside an `exec` call may quote a plan without calling the tool, and is ignored.
 *
 * What a step's time held (its activity) is every other tool call made while it ran: each call
 * goes to the steps in progress then, or to the plan's `outside` while none is. Claude's `Agent`
 * calls and background commands are kept with the agent id and task id their answers give, and a
 * background command's notification, or the TaskStop (KillShell) answer that stopped it, says how it ended.
 *
 * A transcript is read from its start, PLAN_BUDGET bytes per call, then only what was appended;
 * until the first read has reached the end, no plan is told.
 */
const PLAN_BUDGET = 32 * 1024 * 1024;
const LINE_BUDGET = 8 * 1024 * 1024;
const MAX_STEPS = 200;
const MAX_FILES = 256;
/** what one step keeps of its calls: the last few, how many of each tool, and what they started */
const MAX_RECENT = 5;
const MAX_TOOLS = 24;
const MAX_STARTED = 20;
const DETAIL = 160;
/** progress calls are the plan itself, not work done in a step */
const PROGRESS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite", "update_plan"]);

export type PlanSource = "claude-transcript" | "codex-transcript";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const idOf = (value: unknown): string | null => words(typeof value === "number" ? String(value) : value);
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const STATUSES = new Set<PlanStep["status"]>(["pending", "in_progress", "completed"]);

interface Read {
  id: string;
  offset: number;
  skipping: boolean;
  /** the first read has not reached the end of what was written yet */
  catching: boolean;
  /** the last read stopped for its budget: what follows has not been read */
  behind: boolean;
  steps: Map<string, PlanStep>;
  /** Claude's task calls still waiting for their answer, by tool_use id */
  calls: Map<string, { name: string; input: Row }>;
  /** what each step's time held, by step id, and what was done since the plan began while none ran */
  work: Map<string, Work>;
  outside: Work;
  /** an `Agent` or background call waiting for the answer that gives its id, by tool_use id */
  started: Map<string, { agent: PlanActivity["agents"][number]; into: Work[] } | { command: string; into: Work[] }>;
  /** background commands by task id, for the notification or the stop that ends them */
  commands: Map<string, PlanActivity["background"][number]>;
}
const reads = new Map<string, Read>();

interface Work {
  tools: Map<string, number>;
  recent: PlanActivity["recent"];
  last_at: string | null;
  agents: PlanActivity["agents"];
  background: PlanActivity["background"];
}
const work = (): Work => ({ tools: new Map(), recent: [], last_at: null, agents: [], background: [] });

/**
 * The plan in `path` now: its steps in the order they were made, each with what its time held,
 * null when there is none (or it is still being read). `budget`: the bytes this read may take,
 * shared by every read of one poll.
 */
export function readPlan(source: PlanSource, path: string, budget = { left: PLAN_BUDGET }): PlanStep[] | null {
  return readPlanDetail(source, path, budget)?.steps ?? null;
}

/** The plan in `path` now with what was done outside its steps. */
export function readPlanDetail(source: PlanSource, path: string, budget = { left: PLAN_BUDGET }): { steps: PlanStep[]; outside: PlanActivity | null } | null {
  const read = planState(source, path, budget).read;
  if (read === null || read.catching || read.steps.size === 0) return null;
  const steps = [...read.steps.values()].map((step) => {
    const done = shown(read.work.get(step.id));
    return { ...step, blocked_by: [...step.blocked_by], ...(done ? { activity: done } : {}) };
  });
  return { steps, outside: shown(read.outside) };
}

/** A step's activity as the API gives it; null when nothing was done. */
function shown(held: Work | undefined): PlanActivity | null {
  if (held === undefined || (held.tools.size === 0 && held.agents.length === 0 && held.background.length === 0)) return null;
  return {
    tools: [...held.tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    recent: held.recent.map((call) => ({ ...call })),
    last_at: held.last_at,
    agents: held.agents.map((agent) => ({ ...agent })),
    background: held.background.map((command) => ({ ...command })),
  };
}

function planState(source: PlanSource, path: string, budget: { left: number }): { read: Read | null; behind: boolean } {
  const stat = plain(path);
  if (stat === null) return { read: null, behind: false };
  const key = `${source}\0${path}`;
  let state = reads.get(key);
  if (!state || state.id !== stat.id || state.offset > stat.size) {
    state = { id: stat.id, offset: 0, skipping: false, catching: true, behind: true, steps: new Map(), calls: new Map(), work: new Map(), outside: work(), started: new Map(), commands: new Map() };
  }
  remember(reads, key, state, MAX_FILES);
  const read = state;
  const each = source === "claude-transcript" ? (line: string) => claudeLine(read, line) : (line: string) => codexLine(read, line);
  read.behind = read.offset < stat.size;
  while (read.offset < stat.size && budget.left > 0) {
    const done = readLines(path, read.offset, stat.size, LINE_BUDGET, each, read.skipping);
    // the file could not be read this time (gone, out of descriptors): not caught up, tried again at the next poll
    if (done.failed) { read.behind = true; break; }
    const consumed = done.offset - read.offset;
    read.offset = done.offset;
    read.skipping = done.skipping;
    read.behind = done.more;
    budget.left -= consumed;
    // what is left is a line still being written: the next read takes it whole
    if (consumed === 0 || !done.more) break;
  }
  if (!read.behind) read.catching = false;
  return { read, behind: read.behind };
}

/** The steps a call made now belongs to: those in progress, else what is outside them. */
function running(read: Read): Work[] {
  const now = [...read.steps.values()].filter((step) => step.status === "in_progress");
  if (now.length === 0) return [read.outside];
  return now.map((step) => {
    let held = read.work.get(step.id);
    if (held === undefined) read.work.set(step.id, held = work());
    return held;
  });
}

/** One call, counted in each step it belongs to. */
function record(into: Work[], at: string | null, tool: string, detail: string | null): void {
  for (const held of into) {
    const name = held.tools.has(tool) || held.tools.size < MAX_TOOLS ? tool : "other";
    held.tools.set(name, (held.tools.get(name) ?? 0) + 1);
    held.recent.push({ at, tool, detail });
    if (held.recent.length > MAX_RECENT) held.recent.shift();
    held.last_at = at ?? held.last_at;
  }
}

const clip = (value: unknown): string | null => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length === 0 ? null : text.length > DETAIL ? `${text.slice(0, DETAIL - 1)}…` : text;
};
/** a path's last two parts: enough to tell the file, short enough for a row */
const tail = (value: unknown): string | null => typeof value === "string" ? clip(value.split("/").filter(Boolean).slice(-2).join("/")) : null;

/** What a Claude Code tool call was given, as one short line. */
function claudeDetail(name: string, input: Row): string | null {
  switch (name) {
    case "Bash": return clip(input["description"]) ?? clip(input["command"]);
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return tail(input["file_path"] ?? input["notebook_path"]);
    case "Grep": case "Glob": return clip(input["pattern"]);
    case "Agent": case "Task": return clip(input["description"]);
    case "WebFetch": return clip(input["url"]);
    case "WebSearch": return clip(input["query"]);
    case "Skill": return clip(input["skill"]);
    default: return null;
  }
}

/** Forgets every read (tests). */
export function forgetPlans(): void {
  reads.clear();
}

function claudeLine(read: Read, line: string): void {
  // a background command's notification: how it ended
  if (read.commands.size > 0 && line.includes("<task-notification>")) {
    for (const notice of lineNotifications(line)) {
      const command = read.commands.get(notice.taskId);
      if (command !== undefined && !notice.agent) command.status = notice.status;
    }
  }
  const calling = line.includes('"tool_use"');
  // TaskStop (KillShell in older Claude Code) answers with the task it stopped, or the shell: no notice follows
  const stopping = read.commands.size > 0 && (line.includes('"task_id"') || line.includes('"shell_id"'));
  const answering = (read.calls.size > 0 || read.started.size > 0 || stopping) && line.includes('"tool_result"');
  if (!calling && !answering) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const content = row(entry?.["message"])?.["content"];
  if (entry === null || !Array.isArray(content)) return;
  const at = stamp(entry["timestamp"]);
  // a subagent's own calls, where an older Claude Code wrote them into this transcript, are its own
  const own = entry["isSidechain"] !== true;
  for (const value of content) {
    const block = row(value);
    if (block === null) continue;
    if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
      const name = block["name"];
      const input = row(block["input"]) ?? {};
      if (name === "TaskCreate" || name === "TaskUpdate") { read.calls.set(block["id"], { name, input }); continue; }
      if (PROGRESS.has(name) || !own) continue;
      // ponytail: the steps in progress as of the task calls answered so far; a call in the same
      // message as a status change (answered after it) still counts for the step before
      const into = running(read);
      record(into, at, name, claudeDetail(name, input));
      if (name === "Agent" || name === "Task") {
        const agent: PlanActivity["agents"][number] = { id: null, label: clip(input["description"]) ?? name, type: words(input["subagent_type"]), status: "started" };
        for (const held of into) if (held.agents.length < MAX_STARTED) held.agents.push(agent);
        read.started.set(block["id"], { agent, into });
      } else if (name === "Bash") {
        // `run_in_background`, or one the person sent to the background: its answer gives a task id
        read.started.set(block["id"], { command: clip(input["command"]) ?? "", into });
      }
      continue;
    }
    if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
    const answer = row(entry["toolUseResult"]);
    if (stopping && block["is_error"] !== true) {
      const stopped = typeof answer?.["task_type"] === "string" ? answer["task_id"] : answer?.["shell_id"];
      const command = typeof stopped === "string" ? read.commands.get(stopped) : undefined;
      if (command?.status === "running") command.status = "cancelled";
    }
    const start = read.started.get(block["tool_use_id"]);
    if (start !== undefined) {
      read.started.delete(block["tool_use_id"]);
      if ("agent" in start) {
        // a launch answered with an error started no subagent: it stays listed, as failed
        if (block["is_error"] === true) start.agent.status = "failed";
        else start.agent.id = words(answer?.["agentId"]) ?? start.agent.id;
      }
      else {
        const task = words(answer?.["backgroundTaskId"]);
        if (task === null || block["is_error"] === true) continue;
        const command: PlanActivity["background"][number] = { id: task, command: start.command, status: "running" };
        for (const held of start.into) if (held.background.length < MAX_STARTED) held.background.push(command);
        remember(read.commands, task, command, MAX_STEPS);
      }
      continue;
    }
    const call = read.calls.get(block["tool_use_id"]);
    if (call === undefined) continue;
    read.calls.delete(block["tool_use_id"]);
    if (block["is_error"] === true) continue;
    if (call.name === "TaskCreate") created(read, call.input, answer, block["content"], at);
    else updated(read, call.input, answer, at);
  }
  if (read.calls.size > MAX_STEPS) read.calls.clear();
  if (read.started.size > MAX_STEPS) read.started.clear();
}

function created(read: Read, input: Row, answer: Row | null, content: unknown, at: string | null): void {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => row(part)?.["text"]).filter((part) => typeof part === "string").join("") : "";
  const id = idOf(row(answer?.["task"])?.["id"]) ?? text.match(/^Task #(\S+) created/)?.[1] ?? null;
  if (id === null) return;
  // Claude empties a list whose tasks are all done: the next task begins another plan
  if ([...read.steps.values()].every((step) => step.status === "completed")) {
    read.steps.clear();
    read.work.clear();
    read.outside = work();
  }
  if (read.steps.size >= MAX_STEPS) return;
  read.steps.set(id, { id, label: words(input["subject"]) ?? `#${id}`, active: words(input["activeForm"]), status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null });
}

function updated(read: Read, input: Row, answer: Row | null, at: string | null): void {
  if (answer?.["success"] === false) return;
  const id = idOf(input["taskId"]);
  const step = id === null ? undefined : read.steps.get(id);
  if (id === null || step === undefined) return;
  const status = input["status"];
  if (status === "deleted") {
    read.steps.delete(id);
    read.work.delete(id);
    for (const other of read.steps.values()) other.blocked_by = other.blocked_by.filter((before) => before !== id);
    return;
  }
  if (typeof status === "string" && STATUSES.has(status as PlanStep["status"]) && status !== step.status) {
    step.status = status as PlanStep["status"];
    if (step.status === "in_progress") { step.started_at ??= at; step.ended_at = null; }
    if (step.status === "completed") step.ended_at = at;
    if (step.status === "pending") step.ended_at = null;
  }
  step.label = words(input["subject"]) ?? step.label;
  step.active = words(input["activeForm"]) ?? step.active;
  if (typeof input["owner"] === "string") step.owner = words(input["owner"]);
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item) => { const other = idOf(item); return other !== null && other !== id && read.steps.has(other) ? [other] : []; }) : [];
  for (const before of ids(input["addBlockedBy"])) if (!step.blocked_by.includes(before)) step.blocked_by.push(before);
  for (const after of ids(input["addBlocks"])) {
    const other = read.steps.get(after)!;
    if (!other.blocked_by.includes(id)) other.blocked_by.push(id);
  }
}

function codexLine(read: Read, line: string): void {
  if (!line.includes('"function_call"') && !line.includes('"custom_tool_call"')) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const payload = row(entry?.["payload"]);
  if (entry === null || payload === null || typeof payload["name"] !== "string") return;
  const name = payload["name"];
  const at = stamp(entry["timestamp"]);
  let args: unknown;
  if (payload["type"] === "function_call" && typeof payload["arguments"] === "string") {
    let parsed: Row | null = null;
    try { parsed = row(JSON.parse(payload["arguments"])); } catch { /* a call whose arguments are not JSON still counts */ }
    if (name !== "update_plan") {
      const into = running(read);
      record(into, at, name, codexDetail(name, parsed ?? {}, null));
      // a subagent Codex starts is named by its task; its message is not kept in the clear
      if (name === "spawn_agent") {
        const agent: PlanActivity["agents"][number] = { id: null, label: clip(parsed?.["task_name"]) ?? name, type: words(parsed?.["agent_type"]), status: "started" };
        for (const held of into) if (held.agents.length < MAX_STARTED) held.agents.push(agent);
      }
      return;
    }
    args = parsed;
  } else if (payload["type"] === "custom_tool_call" && typeof payload["input"] === "string") {
    const code = payload["input"];
    // code mode's JavaScript: what else it called is the step's work; code is never read as a plan
    const detail = codexDetail(name, {}, code);
    if (name !== "exec" || detail !== null) record(running(read), at, name, detail);
    return;
  } else return;
  const items = row(args)?.["plan"];
  if (!Array.isArray(items)) return;
  const next = items.slice(0, MAX_STEPS).flatMap((item) => {
    const label = words(row(item)?.["step"]);
    const raw = row(item)?.["status"];
    if (label === null) return [];
    const status: PlanStep["status"] = typeof raw === "string" && STATUSES.has(raw as PlanStep["status"]) ? raw as PlanStep["status"] : "pending";
    return [{ label, status }];
  });
  const old = [...read.steps.values()];
  const known = matchSteps(old, next);
  const held = new Map(old.map((step) => [step, read.work.get(step.id)]));
  read.steps.clear();
  read.work.clear();
  // a checklist that shares no step with the one before is another plan: what was done outside the old one is not this one's
  if (known.every((step) => step === undefined)) read.outside = work();
  for (const [index, { label, status }] of next.entries()) {
    const step = known[index];
    const id = String(read.steps.size + 1);
    const started = status === "pending" ? null : step?.started_at ?? at;
    read.steps.set(id, {
      id, label, active: null, status, owner: null,
      blocked_by: read.steps.size > 0 ? [String(read.steps.size)] : [],
      started_at: started,
      ended_at: status === "completed" ? step?.ended_at ?? at : null,
    });
    const done = step && held.get(step);
    if (done !== undefined) read.work.set(id, done);
  }
}

/**
 * Which step of the checklist before each step of the next one is: a Codex checklist names its
 * steps by their words only, so the two are aligned in order (the most steps of the same words,
 * then the most of the same status), and a step removed or added between two of a name moves no
 * other step's times or work onto another. Steps left over (one moved past another) pair up by
 * their words.
 */
function matchSteps(old: readonly PlanStep[], next: readonly { label: string; status: PlanStep["status"] }[]): (PlanStep | undefined)[] {
  const score = (i: number, j: number): number => old[i]!.label !== next[j]!.label ? -1 : old[i]!.status === next[j]!.status ? 3 : 2;
  // best[i][j]: the best alignment of old[i…] with next[j…]
  const best = Array.from({ length: old.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      const pair = score(i, j);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, pair < 0 ? 0 : pair + best[i + 1]![j + 1]!);
    }
  }
  const matched: (PlanStep | undefined)[] = new Array(next.length).fill(undefined);
  for (let i = 0, j = 0; i < old.length && j < next.length;) {
    const pair = score(i, j);
    if (pair >= 0 && best[i]![j] === pair + best[i + 1]![j + 1]!) { matched[j] = old[i]; i++; j++; }
    else if (best[i]![j] === best[i + 1]![j]) i++;
    else j++;
  }
  // a step that moved past another keeps its own too: what is left pairs up by words, in order
  const left = old.filter((step) => !matched.includes(step));
  for (const [j, step] of next.entries()) {
    if (matched[j] !== undefined) continue;
    const at = left.findIndex((candidate) => candidate.label === step.label);
    if (at !== -1) matched[j] = left.splice(at, 1)[0];
  }
  return matched;
}

/**
 * What a Codex tool call was given, as one short line: a command, a patch's files, or in code
 * mode the tools its JavaScript calls (null for code that only keeps the plan).
 */
function codexDetail(name: string, args: Row, code: string | null): string | null {
  if (code !== null) {
    if (name === "apply_patch") {
      const files = [...code.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => tail(match[1]) ?? "");
      return clip([...new Set(files)].join(", "));
    }
    if (name !== "exec") return clip(code.split("\n")[0]);
    const tools = [...new Set([...code.matchAll(/\btools\.(\w+)\s*\(/g)].map((match) => match[1]!))].filter((tool) => tool !== "update_plan");
    return tools.length === 0 ? null : clip(tools.join(", "));
  }
  const command = args["cmd"] ?? args["command"] ?? args["task_name"];
  return clip(Array.isArray(command) ? command.filter((part) => typeof part === "string").join(" ") : command);
}

/** What the sidebar shows of a plan. */
export function planSummary(steps: readonly PlanStep[] | null): PlanSummary | null {
  if (steps === null || steps.length === 0) return null;
  const current = steps.find((step) => step.status === "in_progress");
  return { done: steps.filter((step) => step.status === "completed").length, total: steps.length, current: current ? current.active ?? current.label : null };
}

export interface SessionPlanDeps {
  /** a Claude pane's transcript as the subagent tracker found it (a lookup that costs nothing), null when not known yet */
  claudePath: (paneId: string) => string | null;
  /** a Codex pane's rollout: this costs process calls, so it is asked once per session and again every `relocateMs` */
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  /** a pane's summary changed (null: it has no plan now) */
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  now?: () => number;
  /** how soon a Codex pane whose rollout was not found is looked up again */
  retryMs?: number;
  /** how often a found rollout is checked (a new conversation in the same Codex writes another) */
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  /** the file's size and identity when it was last read: an unchanged file is not read again */
  sig: string | null;
  summary: PlanSummary | null;
}

/**
 * The plans of every Claude Code and Codex pane, for the sidebar. A pane's transcript is looked
 * up once per session (and again now and then while it is not found); a poll reads only a
 * transcript that grew, and tells a pane whose summary changed.
 */
export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  /** the Claude Code and Codex panes of the last snapshot, by the session each runs: a lookup that ends after its pane left is dropped */
  private readonly wanted = new Map<string, string>();
  /** a snapshot has been seen: before one, a pane asked for by the endpoint is taken as it is */
  private refreshed = false;
  private readonly looking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  /**
   * The plan of the pane as herdr has it now (undefined: herdr did not say), with what was done outside its steps, as the
   * poll last read it: null when it has none, or its transcript is not known for the session it runs, or not read to its
   * end yet.
   */
  planOf(pane: HerdrPane | undefined): { steps: PlanStep[]; outside: PlanActivity | null } | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    // a request reads nothing itself, however much was written since: the poll reads, in its shared budget
    return where ? readPlanDetail(where.source, where.path, { left: 0 }) : null;
  }

  /** The pane's transcript is known, and was found for the session the pane runs now. */
  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  /**
   * Follows the Claude Code and Codex panes of a snapshot; a pane that runs neither any more has
   * no plan. Nothing is read here: snapshots can come several times a second, reads come with the poll.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  /**
   * One pane's transcript, looked up now if it is not known (or not known to be this session's).
   * `asked`: a request names the pane from a snapshot of its own, which the last refresh may not have seen yet.
   */
  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex") return;
    const key = keyOf(pane);
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (!due || this.looking.has(pane.pane_id)) return;
    this.looking.add(pane.pane_id);
    try {
      const path = await this.deps.codexPath(pane).catch(() => null);
      // the pane left, or runs another session, while it was looked up: what was found is not its
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      this.track(pane.pane_id, key, path === null ? null : { source: "codex-transcript", path });
    } finally {
      this.looking.delete(pane.pane_id);
    }
  }

  /** Where a pane's plan is now; what was read of the same file stands. */
  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    this.panes.set(paneId, { key, at: this.now(), where, sig: same ? current.sig : null, summary: current?.summary ?? null });
  }

  /** Reads the transcripts that grew, PLAN_BUDGET bytes in all; a pane whose summary changed is told. */
  poll(): void {
    // ponytail: the budget goes to panes in the order they were first followed, so while a very large
    // transcript catches up the panes after it wait about size / PLAN_BUDGET polls; start each poll
    // where the last one stopped if that ever shows
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      let summary: PlanSummary | null = null;
      if (tracked.where !== null) {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig !== null && sig === tracked.sig) continue;
        const { read, behind } = planState(tracked.where.source, tracked.where.path, budget);
        // a file read only in part is read on at the next poll: its size is not taken as seen
        if (!behind) tracked.sig = sig;
        const steps = read === null || read.catching || read.steps.size === 0 ? null : [...read.steps.values()];
        // still on its first read: what it shows is not known yet
        if (steps === null && behind) continue;
        summary = planSummary(steps);
      }
      if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) continue;
      tracked.summary = summary;
      this.deps.onChange(paneId, summary);
    }
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
