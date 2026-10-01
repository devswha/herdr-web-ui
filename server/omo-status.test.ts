import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { omoBackgroundTasks, omoSessionId, OmoStatus, omoTurnStatus, readTail } from "./omo-status.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// records as OmO 5.1.7 writes them
const message = (role: string, stopReason?: string) => JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: "2026-10-02T00:00:00.000Z", message: { role, ...(stopReason ? { stopReason } : {}), content: [] } });
const runtime = (customType: string) => JSON.stringify({ type: "custom_message", customType, display: false, content: "…" });
const bookkeeping = (customType: string) => JSON.stringify({ type: "custom", customType });
const lines = (...entries: string[]) => entries.join("\n") + "\n";

describe("an OmO turn, read from its session file", () => {
  it("runs from a prompt through its tool calls, and is over at an answer that stopped for good", () => {
    expect(omoTurnStatus(lines(message("user")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), bookkeeping("claude-sdk-oauth-binding"), message("assistant", "toolUse")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult")))).toBe("working");
    expect(omoTurnStatus(lines(message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")))).toBe("idle");
    for (const reason of ["error", "aborted"]) expect(omoTurnStatus(lines(message("user"), message("assistant", reason)))).toBe("idle");
  });

  it("starts with one of the runtime's own messages, nobody typing", () => {
    const rested = [message("user"), message("assistant", "stop"), bookkeeping("senpi.hooks.stop-state")];
    for (const start of ["omo-senpi:wake", "senpi-monitor:notification", "senpi-terminal:notification", "goal-continuation", "senpi.todo-owed", "senpi-codemode:notification"]) {
      expect(omoTurnStatus(lines(...rested, runtime(start)))).toBe("working");
    }
    // an error OmO goes on from is a turn again
    expect(omoTurnStatus(lines(message("user"), message("assistant", "error"), bookkeeping("senpi.hooks.stop-state"), runtime("goal-continuation")))).toBe("working");
    // what OmO notes down after a finished answer starts nothing
    for (const note of ["omo-memory:notice", "omo-kibitzer:recall", "senpi-task.usage", "environment-context"]) expect(omoTurnStatus(lines(...rested, runtime(note)))).toBe("idle");
    expect(omoTurnStatus(lines(...rested, bookkeeping("goal-cache-warmup"), bookkeeping("omo-memory:accepted-turns")))).toBe("idle");
  });

  it("says nothing of a text that holds no message, and reads only a file's end", () => {
    expect(omoTurnStatus(lines(bookkeeping("pi-rules.scan"), "not json"))).toBeNull();
    const path = join(root, "2026-10-02T00-00-00-000Z_01a0f88b-481c-7139-8125-c9cd453b9e17.jsonl");
    writeFileSync(path, lines(message("user"), JSON.stringify({ type: "message", message: { role: "toolResult", content: "x".repeat(400_000) } }), message("assistant", "stop")));
    const tail = readTail(path)!;
    expect(tail.text.length).toBeLessThan(300_000);
    expect(omoTurnStatus(tail.text)).toBe("idle");
    expect(omoSessionId(path)).toBe("01a0f88b-481c-7139-8125-c9cd453b9e17");
    expect(readTail(join(root, "none.jsonl"))).toBeNull();
  });

  it("counts a session's running background tasks, not another session's nor a dead host's", () => {
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
    expect(omoBackgroundTasks(cwd, "mine", (pid) => pid === 10)).toBe(2);
    expect(omoBackgroundTasks(join(root, "nowhere"), "mine")).toBe(0);
  });
});

describe("OmO panes' status in place of herdr's", () => {
  const pane = (id: string, agent: string | null, status: AgentStatus): HerdrPane => ({ pane_id: id, agent, agent_status: status, cwd: "/work" } as unknown as HerdrPane);
  const snapshotOf = (...panes: HerdrPane[]): SessionSnapshot => ({ panes, agents: panes.map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status })) } as unknown as SessionSnapshot);
  /** herdr as #286 saw it: an OmO pane reads claude/idle whatever it does */
  const herdr = () => snapshotOf(pane("omo", "claude", "idle"), pane("lost", "claude", "idle"), pane("claude", "claude", "working"), pane("shell", null, "unknown"));

  function setup() {
    const files: Record<string, string> = { "/s/_omo-session.jsonl": lines(message("user"), message("assistant", "stop")) };
    const told: [string, AgentStatus, number][] = [];
    let background = 0;
    const omo = new OmoStatus({
      runsOmo: async (id) => id === "omo" || id === "lost",
      // the session of `lost` cannot be told (two OmO panes in one folder without /proc)
      transcript: async (id) => id === "omo" ? "/s/_omo-session.jsonl" : null,
      snapshot: async () => herdr(),
      onChange: (id, status, count) => told.push([id, status, count]),
      read: (path) => path in files ? { size: files[path]!.length, text: files[path]! } : null,
      background: () => background,
    });
    const append = (...entries: string[]) => { files["/s/_omo-session.jsonl"] += lines(...entries); };
    return { omo, told, append, setBackground: (count: number) => { background = count; } };
  }
  const statuses = (snapshot: SessionSnapshot) => Object.fromEntries(snapshot.panes.map((p) => [p.pane_id, `${p.agent}/${p.agent_status}`]));

  it("reads RUN while a turn runs and DONE when it ends, in events and in every snapshot", async () => {
    const { omo, told, append } = setup();
    const completions = new CompletionTracker(null);
    const read = async () => { const raw = herdr(); await omo.refresh(raw.panes); return omo.apply(raw); };
    const served = () => completions.readSnapshot(read, async (raw) => omo.label(raw));
    // at rest: nothing worked, so READY, and the other panes are herdr's own
    expect(statuses(await served())).toEqual({ omo: "omo/idle", lost: "omo/idle", claude: "claude/working", shell: "null/unknown" });
    expect(omo.tracks("omo")).toBe(true);
    expect(omo.tracks("lost")).toBe(false);
    // a turn starts: told once, and herdr's claude/idle no longer undoes it at the next snapshot
    append(message("user"));
    omo.poll();
    expect(told).toEqual([["omo", "working", 0]]);
    expect(completions.observe("omo", "working", "omo")).toBe("working");
    for (let i = 0; i < 3; i++) expect(statuses(await served())["omo"]).toBe("omo/working");
    append(message("assistant", "toolUse"), message("toolResult"));
    omo.poll();
    expect(told).toHaveLength(1);
    // it ends: DONE, and it stays DONE in the snapshots after
    append(message("assistant", "stop"));
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0]);
    expect(completions.observe("omo", "idle", "omo")).toBe("done");
    for (let i = 0; i < 3; i++) expect(statuses(await served())["omo"]).toBe("omo/done");
    // a finished background task wakes the session: a turn of its own
    append(runtime("omo-senpi:wake"));
    omo.poll();
    expect(completions.observe("omo", told.at(-1)![1], "omo")).toBe("working");
    expect(statuses(await served())["omo"]).toBe("omo/working");
  });

  it("finds a turn already running when the server starts, with no status event at all", async () => {
    const { omo, told, append } = setup();
    append(message("user"));
    const completions = new CompletionTracker(null);
    const raw = herdr();
    await omo.refresh(raw.panes);
    expect(told).toEqual([]);
    const first = completions.present(omo.apply(raw));
    expect(statuses(first)["omo"]).toBe("omo/working");
  });

  it("tells a change in background tasks without calling it a change of status", async () => {
    const { omo, told, setBackground } = setup();
    await omo.refresh(herdr().panes);
    setBackground(2);
    omo.poll();
    expect(told).toEqual([["omo", "idle", 2]]);
    expect(omo.backgroundOf("omo")).toBe(2);
    setBackground(0);
    omo.poll();
    expect(told.at(-1)).toEqual(["omo", "idle", 0]);
  });
});
