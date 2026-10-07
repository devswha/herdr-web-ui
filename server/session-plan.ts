import type { HerdrPane, PlanActivity, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { patchFiles, patchText } from "../shared/patch.ts";
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
 * Codex: each `update_plan` sends the whole checklist, so the last one is the plan. In code mode
 * the call is JavaScript inside an `exec` call (`tools.update_plan({plan:[…]})`); its argument
 * is read by `jsLiteral`, which takes plain literals only and runs nothing.
 *
 * What a step's time held (its activity) is every other tool call made while it ran: each call
 * goes to the steps in progress then, or to the plan's `outside` while none is. Claude's `Agent`
 * calls and background commands are kept with the agent id and task id their answers give, and a
 * background command's notification says how it ended. A Claude call answered with an error counts
 * as failed in its steps, and the files a call wrote or edited are kept by name.
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
const MAX_TOUCHED = 40;
const DETAIL = 160;
/** what a step says it is for */
const DESCRIPTION = 1000;
/** Claude calls whose answer could still be an error: older ones are counted as answered */
const MAX_ASKED = 256;
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
  started: Map<string, { agent: PlanActivity["agents"][number] } | { command: string; into: Work[] }>;
  /** background commands by task id, for the notification that ends them */
  commands: Map<string, PlanActivity["background"][number]>;
  /** Claude's calls not answered with an error yet, by tool_use id: where each was counted, and the file it would change */
  asked: Map<string, { into: Work[]; call: PlanActivity["recent"][number]; file: string | null }>;
}
const reads = new Map<string, Read>();

interface Work {
  tools: Map<string, number>;
  recent: PlanActivity["recent"];
  last_at: string | null;
  agents: PlanActivity["agents"];
  background: PlanActivity["background"];
  files: Map<string, number>;
  failed: number;
}
const work = (): Work => ({ tools: new Map(), recent: [], last_at: null, agents: [], background: [], files: new Map(), failed: 0 });

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
    ...(held.files.size > 0 ? { files: [...held.files].map(([path, count]) => ({ path, count })) } : {}),
    ...(held.failed > 0 ? { failed: held.failed } : {}),
  };
}

function planState(source: PlanSource, path: string, budget: { left: number }): { read: Read | null; behind: boolean } {
  const stat = plain(path);
  if (stat === null) return { read: null, behind: false };
  const key = `${source}\0${path}`;
  let state = reads.get(key);
  if (!state || state.id !== stat.id || state.offset > stat.size) {
    state = { id: stat.id, offset: 0, skipping: false, catching: true, behind: true, steps: new Map(), calls: new Map(), work: new Map(), outside: work(), started: new Map(), commands: new Map(), asked: new Map() };
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

/** One call, counted in each step it belongs to, with the files it wrote or edited; the row it is in their recent calls. */
function record(into: Work[], at: string | null, tool: string, detail: string | null, files: string[] = []): PlanActivity["recent"][number] {
  const call: PlanActivity["recent"][number] = { at, tool, detail };
  for (const held of into) {
    const name = held.tools.has(tool) || held.tools.size < MAX_TOOLS ? tool : "other";
    held.tools.set(name, (held.tools.get(name) ?? 0) + 1);
    held.recent.push(call);
    if (held.recent.length > MAX_RECENT) held.recent.shift();
    held.last_at = at ?? held.last_at;
    for (const file of files) if (held.files.has(file) || held.files.size < MAX_TOUCHED) held.files.set(file, (held.files.get(file) ?? 0) + 1);
  }
  return call;
}

const EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** the files a Codex patch (an `apply_patch` call, or one inside code mode's JavaScript) names */
const patched = (code: string): string[] => { const patch = patchText(code); return patch === null ? [] : patchFiles(patch).flatMap((file) => tail(file) ?? []); };

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
  const answering = (read.calls.size > 0 || read.started.size > 0) && line.includes('"tool_result"');
  // ponytail: an answer is looked at only when it may be an error; one that comes after MAX_ASKED newer calls is not counted
  const failing = read.asked.size > 0 && line.includes('"is_error":true');
  if (!calling && !answering && !failing) return;
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
      const file = EDITS.has(name) ? tail(input["file_path"] ?? input["notebook_path"]) : null;
      remember(read.asked, block["id"], { into, call: record(into, at, name, claudeDetail(name, input), file === null ? [] : [file]), file }, MAX_ASKED);
      if (name === "Agent" || name === "Task") {
        const agent = { id: null, label: clip(input["description"]) ?? name, type: words(input["subagent_type"]) };
        for (const held of into) if (held.agents.length < MAX_STARTED) held.agents.push(agent);
        read.started.set(block["id"], { agent });
      } else if (name === "Bash") {
        // `run_in_background`, or one the person sent to the background: its answer gives a task id
        read.started.set(block["id"], { command: clip(input["command"]) ?? "", into });
      }
      continue;
    }
    if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
    const asked = read.asked.get(block["tool_use_id"]);
    if (asked !== undefined && block["is_error"] === true) {
      read.asked.delete(block["tool_use_id"]);
      asked.call.failed = true;
      for (const held of asked.into) {
        held.failed++;
        // an edit that failed, or was refused, changed nothing
        const count = asked.file === null ? undefined : held.files.get(asked.file);
        if (count === 1) held.files.delete(asked.file!);
        else if (count !== undefined) held.files.set(asked.file!, count - 1);
      }
    }
    const answer = row(entry["toolUseResult"]);
    const start = read.started.get(block["tool_use_id"]);
    if (start !== undefined) {
      read.started.delete(block["tool_use_id"]);
      if ("agent" in start) start.agent.id = words(answer?.["agentId"]) ?? start.agent.id;
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
  const description = said(input["description"]);
  read.steps.set(id, { id, label: words(input["subject"]) ?? `#${id}`, active: words(input["activeForm"]), ...(description === null ? {} : { description }), status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null });
}

/** a step's description, its lines kept */
const said = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, DESCRIPTION) : null;

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
  const description = said(input["description"]);
  if (description !== null) step.description = description;
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
        const agent = { id: null, label: clip(parsed?.["task_name"]) ?? name, type: words(parsed?.["agent_type"]) };
        for (const held of into) if (held.agents.length < MAX_STARTED) held.agents.push(agent);
      }
      return;
    }
    args = parsed;
  } else if (payload["type"] === "custom_tool_call" && typeof payload["input"] === "string") {
    const code = payload["input"];
    // code mode's JavaScript: what else it called is the step's work; a patch that only writes the words is no plan
    const detail = codexDetail(name, {}, code);
    const files = patched(code);
    // code that only applies a patch is a patch, named by its files
    if (name === "exec" && detail === "apply_patch" && files.length > 0) record(running(read), at, "apply_patch", clip(files.join(", ")), files);
    else if (name !== "exec" || detail !== null) record(running(read), at, name, detail, files);
    if (name !== "exec" || !code.includes(PLAN_CALL)) return;
    args = lastPlanCall(code);
  } else return;
  const items = row(args)?.["plan"];
  if (!Array.isArray(items)) return;
  // a step keeps the times and the work it had in the checklists before, found by its words
  const before = new Map([...read.steps.values()].map((step) => [step.label, step]));
  const held = new Map([...read.steps.values()].flatMap((step) => { const done = read.work.get(step.id); return done ? [[step.label, done] as const] : []; }));
  read.steps.clear();
  read.work.clear();
  // a checklist that shares no step with the one before is another plan: what was done outside the old one is not this one's
  if (!items.some((item) => before.has(words(row(item)?.["step"]) ?? ""))) read.outside = work();
  for (const item of items.slice(0, MAX_STEPS)) {
    const label = words(row(item)?.["step"]);
    const raw = row(item)?.["status"];
    if (label === null) continue;
    const status: PlanStep["status"] = typeof raw === "string" && STATUSES.has(raw as PlanStep["status"]) ? raw as PlanStep["status"] : "pending";
    const known = before.get(label);
    const id = String(read.steps.size + 1);
    const started = status === "pending" ? null : known?.started_at ?? at;
    read.steps.set(id, {
      id, label, active: null, status, owner: null,
      blocked_by: read.steps.size > 0 ? [String(read.steps.size)] : [],
      started_at: started,
      ended_at: status === "completed" ? known?.ended_at ?? at : null,
    });
    const done = held.get(label);
    if (done !== undefined) read.work.set(id, done);
  }
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

const PLAN_CALL = "tools.update_plan(";
/** how many calls, from the last one back, are tried: each try may read to the end of the code */
const PLAN_TRIES = 8;

/** The argument of the last `tools.update_plan(…)` call in a piece of Codex code-mode JavaScript that is a plain literal. */
export function lastPlanCall(code: string): unknown {
  let tries = 0;
  for (let at = code.lastIndexOf(PLAN_CALL); at !== -1 && tries < PLAN_TRIES; at = at === 0 ? -1 : code.lastIndexOf(PLAN_CALL, at - 1), tries++) {
    const value = jsLiteral(code, at + PLAN_CALL.length);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The JavaScript literal at `code[from]`: objects (bare or quoted keys), arrays, strings, numbers,
 * true, false and null, with comments and trailing commas; undefined for anything else, such as
 * a variable, a call or a template string with `${}`. Nothing is evaluated.
 */
export function jsLiteral(code: string, from: number): unknown {
  let i = from;
  const fail = (): never => { throw new SyntaxError("not a literal"); };
  const space = (): void => {
    while (i < code.length) {
      if (/\s/.test(code[i]!)) i++;
      else if (code.startsWith("//", i)) { const end = code.indexOf("\n", i); i = end === -1 ? code.length : end + 1; }
      else if (code.startsWith("/*", i)) { const end = code.indexOf("*/", i + 2); if (end === -1) fail(); i = end + 2; }
      else return;
    }
  };
  const string = (): string => {
    const quote = code[i++]!;
    let out = "";
    while (i < code.length && code[i] !== quote) {
      const char = code[i++]!;
      if (quote === "`" && char === "$" && code[i] === "{") fail();
      if (char !== "\\") { if (char === "\n" && quote !== "`") fail(); out += char; continue; }
      const escape = code[i++];
      if (escape === undefined) fail();
      if (escape === "u") {
        const braced = code[i] === "{";
        const close = braced ? code.indexOf("}", i) : -1;
        const hex = braced ? (close === -1 || close > i + 7 ? "" : code.slice(i + 1, close)) : code.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || (!braced && hex.length !== 4) || Number.parseInt(hex, 16) > 0x10ffff) fail();
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += braced ? hex.length + 2 : 4;
      } else if (escape === "\n") {
        // a line continuation adds nothing
      } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<string, string>)[escape!] ?? escape;
    }
    if (code[i] !== quote) fail();
    i++;
    return out;
  };
  const value = (depth: number): unknown => {
    if (depth > 32) fail();
    space();
    const char = code[i];
    if (char === '"' || char === "'" || char === "`") return string();
    if (char === "[") {
      i++;
      const list: unknown[] = [];
      for (;;) {
        space();
        if (code[i] === "]") { i++; return list; }
        list.push(value(depth + 1));
        space();
        if (code[i] === ",") i++;
        else if (code[i] !== "]") fail();
      }
    }
    if (char === "{") {
      i++;
      const object: Row = {};
      for (;;) {
        space();
        if (code[i] === "}") { i++; return object; }
        let key: string;
        if (code[i] === '"' || code[i] === "'") key = string();
        else {
          const name = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 256))?.[0];
          if (name === undefined) fail();
          key = name!;
          i += key.length;
        }
        space();
        if (code[i] !== ":") fail();
        i++;
        // an own key whatever its name: `__proto__` gives the object no prototype to inherit a plan from
        Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        space();
        if (code[i] === ",") i++;
        else if (code[i] !== "}") fail();
      }
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(code.slice(i, i + 64))?.[0];
    if (number !== undefined) { i += number.length; return Number(number); }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) {
      if (code.startsWith(word, i) && !/[\w$]/.test(code[i + word.length] ?? "")) { i += word.length; return literal; }
    }
    return fail();
  };
  try { return value(0); } catch { return undefined; }
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

  /** The pane's plan now, read on the spot, with what was done outside its steps; null when it has none or its transcript is not known. */
  planOf(paneId: string): { steps: PlanStep[]; outside: PlanActivity | null } | null {
    const where = this.panes.get(paneId)?.where;
    return where ? readPlanDetail(where.source, where.path) : null;
  }

  known(paneId: string): boolean {
    return this.panes.get(paneId)?.where != null;
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
