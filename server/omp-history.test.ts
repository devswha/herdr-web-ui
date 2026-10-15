import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { listOmpSessions, OmpResumer, openOmpSessions, ompSessionDirNames, ompSessionsRoot, resolveOmpSession, type OmpResumeDeps } from "./omp-history.ts";

let home: string;
let cwd: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "omp-history-home-")));
  cwd = join(home, "project");
  mkdirSync(cwd);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const header = (id: string, folder: string, title = "") => [
  JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-10-01T00:00:00Z", pad: " ".repeat(40) }),
  JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00Z", cwd: folder }),
];
const prompt = (text: string) => JSON.stringify({ type: "message", id: "m", message: { role: "user", content: [{ type: "text", text }] } });

/** A session file in the store directory omp would use for `folder`; `age` seconds older than now. */
function session(name: string, lines: string[], folder = cwd, age = 0): string {
  const directory = join(ompSessionsRoot(home), ompSessionDirNames(folder, home, tmpdir())[0]!);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  const when = new Date(Date.now() - age * 1000);
  utimesSync(path, when, when);
  return path;
}

describe("listOmpSessions", () => {
  it("lists a folder's sessions newest write first, with title, preview and size", () => {
    session("2026-10-01_a", [...header("id-a", cwd, "First"), prompt("fix the\n  parser")], cwd, 100);
    session("2026-10-02_b", [...header("id-b", cwd), prompt("write tests")], cwd, 10);
    const { sessions, has_more } = listOmpSessions(cwd, new Set(), 10, home, tmpdir());
    expect(has_more).toBe(false);
    expect(sessions.map((entry) => entry.session_id)).toEqual(["id-b", "id-a"]);
    expect(sessions[0]).toMatchObject({ title: null, preview: "write tests" });
    expect(sessions[1]).toMatchObject({ title: "First", preview: "fix the parser" });
    expect(sessions[1]!.size_bytes).toBeGreaterThan(0);
  });

  it("reads only a file's first bytes: a prompt past them gives no preview, however large the file", () => {
    const filler = JSON.stringify({ type: "custom", data: "x".repeat(256 * 1024) });
    const path = session("2026-10-01_big", [...header("id-big", cwd, "Huge"), filler, prompt("too late")]);
    const [entry] = listOmpSessions(cwd, new Set(), 10, home, tmpdir()).sessions;
    expect(entry).toMatchObject({ session_id: "id-big", title: "Huge", preview: null, path });
    expect(entry!.size_bytes).toBeGreaterThan(256 * 1024);
  });

  it("leaves out sessions open panes show, other folders' files and subagent transcripts", () => {
    const open = session("2026-10-01_open", [...header("id-open", cwd), prompt("open")]);
    session("2026-10-01_closed", [...header("id-closed", cwd), prompt("closed")]);
    // a file of another folder that omp's encoding put in the same directory
    session("2026-10-01_other", [...header("id-other", join(home, "elsewhere")), prompt("other")], cwd);
    const nested = join(ompSessionsRoot(home), ompSessionDirNames(cwd, home, tmpdir())[0]!, "2026-10-01_closed");
    mkdirSync(nested);
    writeFileSync(join(nested, "0-Sub.jsonl"), header("id-sub", cwd).join("\n") + "\n");
    const { sessions } = listOmpSessions(cwd, new Set([open]), 10, home, tmpdir());
    expect(sessions.map((entry) => entry.session_id)).toEqual(["id-closed"]);
  });

  it("caps the list at the limit and says more exist", () => {
    for (let index = 0; index < 3; index++) session(`2026-10-0${index + 1}_s`, [...header(`id-${index}`, cwd), prompt("p")], cwd, 100 - index);
    const { sessions, has_more } = listOmpSessions(cwd, new Set(), 2, home, tmpdir());
    expect(sessions.map((entry) => entry.session_id)).toEqual(["id-2", "id-1"]);
    expect(has_more).toBe(true);
  });

  it("answers an empty list for a folder with no store", () => {
    expect(listOmpSessions(cwd, new Set(), 5, home, tmpdir())).toEqual({ sessions: [], has_more: false });
  });
});

describe("resolveOmpSession", () => {
  it("accepts a main session of the folder, by its real path", () => {
    const path = session("2026-10-01_ok", [...header("id-ok", cwd)]);
    expect(resolveOmpSession(path, cwd, home)).toEqual({ path, id: "id-ok" });
  });

  it("refuses a path that is not a session of this folder inside the store", () => {
    const path = session("2026-10-01_ok", [...header("id-ok", cwd)]);
    const outside = join(home, "outside.jsonl");
    writeFileSync(outside, header("id-out", cwd).join("\n") + "\n");
    const link = join(path, "..", "link.jsonl");
    symlinkSync(outside, link);
    const nestedDirectory = join(path, "..", "2026-10-01_ok");
    mkdirSync(nestedDirectory);
    const nested = join(nestedDirectory, "0-Sub.jsonl");
    writeFileSync(nested, header("id-sub", cwd).join("\n") + "\n");
    const elsewhere = session("2026-10-01_else", [...header("id-else", join(home, "elsewhere"))]);
    for (const candidate of [outside, link, nested, elsewhere, "relative.jsonl", join(home, "missing.jsonl"), 7, null]) {
      expect(resolveOmpSession(candidate, cwd, home)).toBeNull();
    }
  });
});

const pane = (paneId: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({ pane_id: paneId, workspace_id: "w1", ...extra }) as HerdrPane;

describe("openOmpSessions", () => {
  it("names the session of each omp pane: herdr's, else the pane's own process, and ignores other panes", async () => {
    const reported = session("2026-10-01_r", [...header("id-r", cwd)]);
    const held = session("2026-10-01_h", [...header("id-h", cwd)]);
    const panes = [
      pane("p1", { agent: "omp", agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: reported } }),
      pane("p2", { agent: "omp" }),
      pane("p3", { agent: "claude", agent_session: { agent: "claude", kind: "id", source: "x", value: "c" } }),
    ];
    const open = await openOmpSessions(panes, async (candidate) => candidate.pane_id === "p2" ? held : null);
    expect([...open]).toEqual([[reported, "p1"], [held, "p2"]]);
  });
});

/** A promise settled from outside, so a test orders the events instead of waiting on a clock. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function resumer(overrides: Partial<OmpResumeDeps> = {}) {
  const calls = { createTab: [] as [string, string][], launch: [] as [string, string[]][], focus: [] as string[] };
  const panes: HerdrPane[] = [pane("p0")];
  /** the panes herdr's agent.get answers `launch_pending` for: registered by a launch, gone (agent_not_found) once the process exits */
  const registered = new Set<string>();
  const deps: OmpResumeDeps = {
    panes: async () => panes,
    open: async () => new Map(),
    focus: async (paneId) => { calls.focus.push(paneId); },
    createTab: async (workspaceId, folder) => {
      calls.createTab.push([workspaceId, folder]);
      const created = pane(`p${panes.length}`, { workspace_id: workspaceId });
      panes.push(created);
      return { workspace_id: workspaceId, pane_id: created.pane_id };
    },
    // a pane herdr has just started omp in, as observed on herdr 0.9.5: no agent, no session, status "unknown" until it detects omp; agent.get already has the launch registered
    launch: async (paneId, args) => { calls.launch.push([paneId, args]); const started = panes.find((candidate) => candidate.pane_id === paneId); if (started) started.agent_status = "unknown"; registered.add(paneId); return { agent_started: true }; },
    launchPending: async (paneId) => registered.has(paneId),
    ...overrides,
  };
  return { calls, panes, registered, resumer: new OmpResumer(deps) };
}

describe("OmpResumer", () => {
  it("starts omp with the exact session file in a new tab of the workspace", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls } = resumer();
    expect(await subject.resume({ path }, "w1", cwd)).toEqual({ workspace_id: "w1", pane_id: "p1", outcome: "started", agent_started: true });
    expect(calls.createTab).toEqual([["w1", cwd]]);
    expect(calls.launch).toEqual([["p1", ["--resume", path]]]);
  });

  it("starts a session once however many ask while it starts", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const gate = deferred<{ agent_started: true }>();
    const { resumer: subject, calls } = resumer({ launch: async (paneId, args) => { calls.launch.push([paneId, args]); return gate.promise; } });
    const first = subject.resume({ path }, "w1", cwd);
    const second = subject.resume({ path }, "w1", cwd);
    gate.resolve({ agent_started: true });
    expect(await first).toEqual(await second);
    expect(calls.createTab).toHaveLength(1);
    expect(calls.launch).toHaveLength(1);
  });

  it("focuses the pane that shows the session instead of starting another", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes } = resumer({ open: async () => new Map([[path, "p7"]]) });
    panes.push(pane("p7", { workspace_id: "w2" }));
    expect(await subject.resume({ path }, "w1", cwd)).toEqual({ workspace_id: "w2", pane_id: "p7", outcome: "focused", agent_started: true });
    expect(calls.focus).toEqual(["p7"]);
    expect(calls.createTab).toEqual([]);
  });

  it("focuses the pane it started before herdr names its session, and starts again once that pane is gone", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes } = resumer();
    await subject.resume({ path }, "w1", cwd);
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p1", outcome: "focused" });
    panes.splice(panes.findIndex((candidate) => candidate.pane_id === "p1"), 1);
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ outcome: "started" });
    expect(calls.createTab).toHaveLength(2);
  });

  it("does not remember a start that failed: the next ask tries again", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const failure = { agent_started: false as const, error: { code: "agent_start_failed", message: "no omp" } };
    let fail = true;
    const { resumer: subject, calls } = resumer({ launch: async () => fail ? failure : { agent_started: true } });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ outcome: "started", agent_started: false, error: failure.error });
    fail = false;
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ outcome: "started", agent_started: true });
    expect(calls.createTab).toHaveLength(2);
  });

  it("starts again, without focusing the shell, when the pane it started is a shell herdr reports unknown with no agent registered", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes, registered } = resumer();
    await subject.resume({ path }, "w1", cwd);
    // observed after omp exited: process_info shows only the shell, agent.get answers agent_not_found, and the status went idle and later back to unknown
    registered.delete("p1");
    Object.assign(panes.find((candidate) => candidate.pane_id === "p1")!, { agent: null, agent_session: null, agent_status: "unknown" });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
    expect(calls.launch).toEqual([["p1", ["--resume", path]], ["p2", ["--resume", path]]]);
  });

  it("keeps focusing the pane it started while herdr has its launch registered, even when the pane reports no agent or session and status idle", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes, registered } = resumer();
    await subject.resume({ path }, "w1", cwd);
    expect(registered.has("p1")).toBe(true);
    Object.assign(panes.find((candidate) => candidate.pane_id === "p1")!, { agent: null, agent_session: null, agent_status: "idle" });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p1", outcome: "focused" });
    expect(calls.focus).toEqual(["p1"]);
    expect(calls.createTab).toHaveLength(1);
    expect(calls.launch).toHaveLength(1);
  });

  it("answers the failure when herdr cannot say whether the launch is pending, instead of guessing", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    let fail = false;
    const { resumer: subject, calls } = resumer({ launchPending: async () => { if (fail) throw new Error("herdr unreachable"); return true; } });
    await subject.resume({ path }, "w1", cwd);
    fail = true;
    await expect(subject.resume({ path }, "w1", cwd)).rejects.toThrow("herdr unreachable");
    expect(calls.focus).toEqual([]);
    expect(calls.createTab).toHaveLength(1);
  });

  /** herdr's view of a pane once it detected omp (before and without naming a session), and of the shell left when omp exits */
  const detected = (target: HerdrPane): void => { Object.assign(target, { agent: "omp", agent_status: "idle" }); };
  const exited = (target: HerdrPane): void => { Object.assign(target, { agent: null, agent_session: null, agent_status: "idle" }); };

  it("keeps focusing the pane it started while omp runs there with no session reported", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes } = resumer();
    await subject.resume({ path }, "w1", cwd);
    detected(panes.find((candidate) => candidate.pane_id === "p1")!);
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p1", outcome: "focused" });
    expect(calls.createTab).toHaveLength(1);
    expect(calls.launch).toHaveLength(1);
  });

  it("starts again, without focusing the shell, once omp exited from the pane it started", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes, registered } = resumer();
    await subject.resume({ path }, "w1", cwd);
    const first = panes.find((candidate) => candidate.pane_id === "p1")!;
    detected(first);
    exited(first);
    registered.delete("p1");
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
    expect(calls.launch).toEqual([["p1", ["--resume", path]], ["p2", ["--resume", path]]]);
  });

  it("starts again when the pane it started now reports another session", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const other = session("2026-10-01_y", [...header("id-y", cwd)]);
    const { resumer: subject, calls, panes } = resumer();
    await subject.resume({ path }, "w1", cwd);
    Object.assign(panes.find((candidate) => candidate.pane_id === "p1")!, { agent: "omp", agent_status: "idle", agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: other } });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
  });

  it("starts again when the pane it started holds another transcript that herdr does not report", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const other = session("2026-10-01_y", [...header("id-y", cwd)]);
    // the real open map: an omp pane names the file its own process holds, a shell has none
    const open = (current: readonly HerdrPane[]) => openOmpSessions(current, async (candidate) => candidate.agent === "omp" && candidate.pane_id === "p1" ? other : null);
    const { resumer: subject, calls, panes } = resumer({ open });
    await subject.resume({ path }, "w1", cwd);
    detected(panes.find((candidate) => candidate.pane_id === "p1")!);
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
  });

  it("starts again when the pane it started now shows another agent, status still unknown", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes } = resumer();
    await subject.resume({ path }, "w1", cwd);
    Object.assign(panes.find((candidate) => candidate.pane_id === "p1")!, { agent: "claude", agent_status: "unknown" });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
  });

  it("starts again when the pane it started reports another agent's session, status still unknown", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    const { resumer: subject, calls, panes } = resumer();
    await subject.resume({ path }, "w1", cwd);
    Object.assign(panes.find((candidate) => candidate.pane_id === "p1")!, { agent_session: { agent: "claude", kind: "id", source: "x", value: "c" }, agent_status: "unknown" });
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p2", outcome: "started" });
    expect(calls.focus).toEqual([]);
  });

  it("prefers what the open panes show now: another pane showing the session is focused over a stale started one", async () => {
    const path = session("2026-10-01_x", [...header("id-x", cwd)]);
    let shown = new Map<string, string>();
    const { resumer: subject, calls, panes } = resumer({ open: async () => shown });
    await subject.resume({ path }, "w1", cwd);
    exited(panes.find((candidate) => candidate.pane_id === "p1")!);
    panes.push(pane("p7"));
    shown = new Map([[path, "p7"]]);
    expect(await subject.resume({ path }, "w1", cwd)).toMatchObject({ pane_id: "p7", outcome: "focused" });
    expect(calls.focus).toEqual(["p7"]);
    expect(calls.createTab).toHaveLength(1);
  });
});
