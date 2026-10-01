import { afterAll, describe, expect, it } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { noTurn, omoBackgroundTasks, omoSessionId, OmoStatus, omoTurnAfter, omoTurnStatus, readLines, type OmoLine, type OmoPane } from "./omo-status.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// records as OmO 5.1.7 writes them
const message = (role: string, stopReason?: string, at = "2026-10-02T00:00:10.000Z", text = "") => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: at, message: { role, content: [{ type: "text", text }], ...(stopReason ? { stopReason } : {}) } });
const runtime = (customType: string) => JSON.stringify({ type: "custom_message", customType, display: false, content: "…", timestamp: "2026-10-02T00:00:20.000Z" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";

describe("an OmO turn, read from its session file", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    expect(omoTurnStatus(lines(message("user")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), bookkeeping("claude-sdk-oauth-binding"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "aborted")))).toBe("idle");
  });

  it("goes on through an error OmO retries, until OmO says it stopped", () => {
    // seen in real files: an error, then the next answer 2 to 16 s later with nothing in between
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), message("assistant", "error")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), message("assistant", "stop")))).toBe("idle");
    // it gave up: its stop record ends the turn
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state")))).toBe("idle");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), runtime("goal-continuation")))).toBe("working");
    // the same record after a finished answer, or while a tool runs, changes nothing
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), bookkeeping("senpi.hooks.stop-state")))).toBe("working");
  });

  it("starts with one of the runtime's own messages, nobody typing", () => {
    const rested = [message("user"), message("assistant", "stop"), bookkeeping("senpi.hooks.stop-state")];
    for (const start of ["omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification", "goal-continuation", "senpi.todo-owed", "senpi-codemode:notification", "omo-init-deep-advisor:run"]) {
      expect(omoTurnStatus(lines(...rested, runtime(start)))).toBe("working");
    }
    // what OmO notes down after a finished answer starts nothing
    for (const note of ["omo-memory:notice", "omo-kibitzer:recall", "senpi-task.usage", "environment-context"]) expect(omoTurnStatus(lines(...rested, runtime(note)))).toBe("idle");
    expect(omoTurnStatus(lines(...rested, bookkeeping("goal-cache-warmup"), bookkeeping("omo-memory:accepted-turns")))).toBe("idle");
    expect(omoTurnStatus(lines(bookkeeping("pi-rules.scan"), "not json"))).toBeNull();
  });

  it("reads a record of any size by its ends, and only whole lines", () => {
    const path = join(root, "2026-10-02T00-00-00-000Z_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl");
    const big = "x".repeat(400_000);
    // a prompt and an answer each far longer than a read holds
    writeFileSync(path, lines(message("assistant", "stop"), message("user", undefined, "2026-10-02T00:01:00.000Z", big)));
    const read = (from = 0) => {
      const seen: OmoLine[] = [];
      const fd = openSync(path, "r");
      try { return { offset: readLines(fd, from, statSync(path).size, (line) => seen.push(line)), seen }; } finally { closeSync(fd); }
    };
    let { seen, offset } = read();
    expect(seen.map((line) => "text" in line ? "whole" : "ends")).toEqual(["whole", "ends"]);
    expect(seen.reduce(omoTurnAfter, noTurn())).toMatchObject({ status: "working", at: Date.parse("2026-10-02T00:01:00.000Z") });
    expect(offset).toBe(statSync(path).size);
    writeFileSync(path, lines(message("user"), message("assistant", "stop", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("idle");
    writeFileSync(path, lines(message("user"), message("assistant", "toolUse", "2026-10-02T00:02:00.000Z", big)));
    expect(read().seen.reduce(omoTurnAfter, noTurn()).status).toBe("working");
    // a last line still being written waits for its newline
    writeFileSync(path, lines(message("user")) + message("assistant", "stop").slice(0, 40));
    ({ seen, offset } = read());
    expect(seen).toHaveLength(1);
    expect(offset).toBe(Buffer.byteLength(lines(message("user"))));
    expect(omoSessionId(path)).toBe("01a0f88b-481c-7139-8125-c9cd453b9e17");
  });

  it("counts each session's running background tasks, not a dead host's", () => {
    const cwd = join(root, "project");
    const tasks = join(cwd, ".omo", "senpi-task", "tasks");
    mkdirSync(tasks, { recursive: true });
    const task = (name: string, record: Record<string, unknown>) => writeFileSync(join(tasks, name), JSON.stringify(record));
    task("st_1.json", { task_id: "st_1", status: "running", parent_session_id: "mine", host_pid: 10 });
    task("st_2.json", { task_id: "st_2", status: "completed", parent_session_id: "mine", host_pid: 10 });
    task("st_3.json", { task_id: "st_3", status: "running", parent_session_id: "other", host_pid: 10 });
    task("st_4.json", { task_id: "st_4", status: "running", parent_session_id: "mine", host_pid: 99 });
    task("st_5.json", { task_id: "st_5", status: "running", parent_session_id: "mine" });
    writeFileSync(join(tasks, "st_6.json"), "{half");
    expect(Object.fromEntries(omoBackgroundTasks(cwd, (pid) => pid === 10))).toEqual({ mine: 2, other: 1 });
    expect(omoBackgroundTasks(join(root, "nowhere")).size).toBe(0);
  });
});

describe("OmO panes' status in place of herdr's", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr as #286 saw it: an OmO pane reads claude/idle whatever it does */
  const herdr = () => snapshotOf(pane("omo", "claude", "idle"), pane("lost", "claude", "idle"), pane("claude", "claude", "working"), pane("shell", null, "unknown"));
  const FILE = "/s/2026_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl";

  function setup(initial = lines(message("user"), message("assistant", "stop"))) {
    const files: Record<string, string> = { [FILE]: initial };
    const told: [string, AgentStatus, number, boolean][] = [];
    const found: string[] = [];
    const state = { background: 0, discovered: new Map<string, OmoPane>([["omo", { path: FILE, startedAt: null }], ["lost", { path: null, startedAt: null }]]), lookups: 0, clock: 0, during: () => {} };
    const omo = new OmoStatus({
      // the session of `lost` cannot be told (two OmO panes in one folder without /proc)
      discover: async () => { state.lookups += 1; state.during(); return new Map(state.discovered); },
      snapshot: async () => herdr(),
      onChange: (id, status, count, turn) => told.push([id, status, count, turn]),
      onFound: (id) => found.push(id),
      file: {
        size: (path) => path in files ? Buffer.byteLength(files[path]!) : null,
        lines: (path, from, size, each) => { const text = Buffer.from(files[path]!).subarray(from, size).toString("utf8"); const whole = text.slice(0, text.lastIndexOf("\n") + 1); for (const line of whole.split("\n").slice(0, -1)) each({ text: line }); return from + Buffer.byteLength(whole); },
      },
      background: () => new Map([["01a0f88b-481c-7139-8125-c9cd453b9e17", state.background]]),
      now: () => state.clock,
    });
    const append = (...entries: string[]) => { files[FILE] += lines(...entries); };
    return { omo, told, found, append, state };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { omo, told, append, state } = setup();
    const completions = new CompletionTracker(null);
    const served = () => completions.readSnapshot(async () => { const raw = herdr(); await omo.refresh(raw.panes); return omo.apply(raw); });
    // at rest: nothing worked, so READY; every OmO pane is `omo`, and the other panes are herdr's own
    expect(statuses(await served())).toEqual({ omo: "omo/idle", lost: "omo/idle", claude: "claude/working", shell: "null/unknown" });
    expect([omo.tracks("omo"), omo.tracks("lost"), omo.runs("lost"), omo.runs("claude")]).toEqual([true, false, true, false]);
    // a turn starts: told once, and herdr's claude/idle no longer undoes it at the next snapshot
    append(message("user"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/working"); }
    append(message("assistant", "toolUse"), message("toolResult"));
    omo.poll();
    expect(told).toHaveLength(1);
    // it ends: DONE, and it stays DONE in the snapshots after, across refreshes
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, true]);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    for (let i = 0; i < 3; i++) { state.clock += 10_000; expect(statuses(await served())["omo"]).toBe("omo/done"); }
    // a finished background task wakes the session: a turn of its own
    append(runtime("omo-senpi:wake"));
    omo.poll();
    expect(completions.observe("omo", told.at(-1)![1], "omo")).toBe("working");
    expect(statuses(await served())["omo"]).toBe("omo/working");
  });

  it("tells a turn that ended while the panes were being looked up again", async () => {
    const { omo, told, append, state } = setup(lines(message("user")));
    await omo.refresh(herdr().panes);
    expect(told).toEqual([]);
    // the answer lands during the lookup of the next refresh: it is told, not swallowed
    state.clock += 10_000;
    state.during = () => append(message("assistant", "stop"));
    await omo.refresh(herdr().panes);
    expect(told).toEqual([["omo", "idle", 0, true]]);
  });

  it("finds a turn already running when the server starts, and takes over what herdr's name finished", async () => {
    const { omo, told, found } = setup(lines(message("user")));
    const completions = new CompletionTracker(null);
    // before: herdr's own events, under its name for the pane
    completions.observe("omo", "working", "claude");
    expect(completions.observe("omo", "idle", "claude")).toBe("done");
    const raw = herdr();
    await omo.refresh(raw.panes);
    for (const paneId of found) completions.adopt(paneId, "omo");
    expect(found.sort()).toEqual(["lost", "omo"]);
    expect(told).toEqual([]);
    expect(statuses(completions.present(omo.apply(raw)))["omo"]).toBe("omo/working");
    // a pane whose session is lost and found again keeps its DONE: its identity never changed
    completions.observe("lost", "working", "omo");
    expect(completions.observe("lost", "idle", "omo")).toBe("done");
    expect(statuses(completions.present(omo.apply(herdr())))["lost"]).toBe("omo/done");
  });

  it("does not take an unfinished turn of a process that is gone for a running one", async () => {
    // killed after a tool call, then resumed by a new process without a prompt
    const { omo, state, append, told } = setup(lines(message("user", undefined, "2026-10-02T00:00:10.000Z"), message("assistant", "toolUse", "2026-10-02T00:00:12.000Z")));
    state.discovered.set("omo", { path: FILE, startedAt: Date.parse("2026-10-02T00:05:00.000Z") });
    const raw = herdr();
    await omo.refresh(raw.panes);
    expect(statuses(omo.apply(raw))["omo"]).toBe("omo/idle");
    // a prompt to the new process is a turn
    append(message("user", undefined, "2026-10-02T00:06:00.000Z"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0, true]]);
  });

  it("tells a change in background tasks as that, not as a turn", async () => {
    const { omo, told, state } = setup();
    await omo.refresh(herdr().panes);
    state.background = 2;
    omo.poll();
    expect(told).toEqual([["omo", "idle", 2, false]]);
    expect(omo.backgroundOf("omo")).toBe(2);
    state.background = 0;
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0, false]);
  });

  it("looks the panes up once per refresh, and not again while nothing changed", async () => {
    const { omo, state } = setup();
    await omo.refresh(herdr().panes);
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(1);
    state.clock += 6000;
    await omo.refresh(herdr().panes);
    expect(state.lookups).toBe(2);
  });
});
