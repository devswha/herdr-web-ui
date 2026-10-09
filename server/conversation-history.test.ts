import { afterEach, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { ConversationUnavailable, forgetTranscriptState, resolveTranscript } from "./conversation.ts";
import { ConversationHistory, type ConversationHistoryRuntime } from "./conversation-history.ts";

const roots: string[] = [];
afterEach(() => { forgetTranscriptState(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const empty = (): SessionSnapshot => ({ agents: [], panes: [], tabs: [], workspaces: [], layouts: [], protocol: 1, version: "test" });
const pane = (id: string, cwd: string): HerdrPane => ({
  pane_id: id, workspace_id: `workspace-${id}`, tab_id: `tab-${id}`, terminal_id: `terminal-${id}`,
  focused: false, revision: 1, agent: "omo", agent_status: "idle", cwd,
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-history-")));
  roots.push(root);
  const cwd = join(root, "project");
  const omoHome = join(root, "omo");
  const stateDir = join(root, "state");
  const codexHome = join(root, "codex");
  mkdirSync(cwd);
  const dir = join(omoHome, "sessions", `-${cwd.replaceAll("/", "-")}--`);
  mkdirSync(dir, { recursive: true });
  const session = (id: string, text = id) => {
    const path = join(dir, `2026-10-08T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(path, [
      { type: "session", version: 3, id, cwd, timestamp: "2026-10-08T00:00:00Z" },
      { type: "session_info", name: `Title ${text}` },
      { type: "message", id: `${id}-message`, message: { role: "user", content: [{ type: "text", text }] } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    return path;
  };
  let snapshot = empty();
  let boot = "boot-one";
  let busy = false;
  const resolutions = new Map<string, { source: "omo-transcript" | "codex-transcript"; path: string }>();
  const created: string[] = [], closed: string[] = [], started: { paneId: string; args: string[] }[] = [];
  const runtime: ConversationHistoryRuntime = {
    snapshot: async () => snapshot,
    resolve: async (current) => {
      const found = resolutions.get(current.pane_id);
      if (!found) throw new ConversationUnavailable("no_session_path");
      return found;
    },
    create: async () => {
      const id = `created-${created.length}`;
      created.push(id);
      return { pane_id: id, workspace_id: `workspace-${id}`, terminal_id: `terminal-${id}` };
    },
    start: async (paneId, args) => { started.push({ paneId, args }); },
    close: async (id) => { closed.push(id); },
    bootIdentity: () => boot,
    processInfo: async () => ({ shell_pid: 10, foreground_processes: [{ pid: busy ? 11 : 10, argv: busy ? ["vim"] : ["/bin/zsh"] }] }),
    inputIdle: async () => true,
  };
  const options = { stateDir, omoHome, codexHome, socketPath: join(root, "herdr.sock"), runtime };
  return { root, cwd, dir, session, options, runtime, created, closed, started, resolutions,
    setBoot: (value: string) => { boot = value; }, setBusy: (value: boolean) => { busy = value; },
    setSnapshot: (panes: HerdrPane[]) => { snapshot = { ...empty(), panes }; return snapshot; },
    registry: () => join(stateDir, readdirSync(stateDir).find((name) => name.endsWith(".json")) ?? "missing") };
}

it("retains the same identity and messages across service restart and transcript append", async () => {
  // Given an imported native session.
  const f = fixture(), path = f.session("session-one", "original message");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  appendFileSync(path, JSON.stringify({ type: "session_info", name: "renamed" }) + "\n");
  // When the service is reconstructed from its durable index.
  const restarted = new ConversationHistory(f.options);
  // Then the identity and native messages survive.
  expect(await restarted.list()).toMatchObject([{ id: saved.id, title: "renamed", state: "closed" }]);
  expect((await restarted.read(saved.id)).turns[0]?.parts).toEqual([{ kind: "text", text: "original message" }]);
  expect(statSync(f.registry()).mode & 0o777).toBe(0o600);
});

it("keeps same-cwd conversations separate after panes disappear", async () => {
  // Given two exact live sessions in one directory.
  const f = fixture(), a = f.session("first"), b = f.session("second");
  f.resolutions.set("a", { source: "omo-transcript", path: a });
  f.resolutions.set("b", { source: "omo-transcript", path: b });
  const history = new ConversationHistory(f.options);
  await history.observe(f.setSnapshot([pane("a", f.cwd), pane("b", f.cwd)]));
  // When their panes disappear.
  await history.observe(f.setSnapshot([]));
  // Then both histories remain independently readable, without restoring deliberate same-boot closes.
  const records = await history.list();
  expect(new Set(records.map((row) => row.id)).size).toBe(2);
  expect(records.every((row) => row.state === "closed" && row.pane_id === null)).toBeTrue();
  expect((await Promise.all(records.map((row) => history.read(row.id)))).map((row) => row.turns[0]?.parts[0])).toEqual(expect.arrayContaining([{ kind: "text", text: "first" }, { kind: "text", text: "second" }]));
  expect(await new ConversationHistory(f.options).restoreTargets()).toEqual([]);
});

it("retains missing transcripts as unavailable instead of deleting them", async () => {
  const f = fixture(), path = f.session("missing");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When the native file disappears.
  rmSync(path);
  // Then reads fail explicitly but the record survives a restart.
  const restarted = new ConversationHistory(f.options);
  expect(await restarted.list()).toMatchObject([{ id: saved.id, state: "unavailable", can_resume: false }]);
  await expect(restarted.read(saved.id)).rejects.toMatchObject({ code: "conversation_unavailable" });
});

it("imports only valid top-level sessions, excluding artifacts, mismatches and escaped links", async () => {
  const f = fixture(), good = f.session("good");
  const data = readFileSync(good, "utf8");
  mkdirSync(join(f.dir, "child-artifacts"));
  writeFileSync(join(f.dir, "child-artifacts", basename(good)), data);
  writeFileSync(join(f.dir, "unrelated.jsonl"), data);
  writeFileSync(join(f.dir, "2026-10-08T00-00-00-000Z_wrong.jsonl"), data);
  writeFileSync(join(f.dir, "2026-10-08T00-00-00-000Z_broken.jsonl"), "{");
  const subagent = f.session("subagent");
  writeFileSync(subagent, JSON.stringify({ type: "session", id: "subagent", cwd: f.cwd, parentSessionId: "good" }) + "\n");
  const outside = join(f.root, "2026-10-08T00-00-00-000Z_escape.jsonl");
  writeFileSync(outside, data);
  symlinkSync(outside, join(f.dir, basename(outside)));
  // When discovery scans the trusted store.
  const records = await new ConversationHistory(f.options).list();
  // Then only the real parent conversation is imported.
  expect(records.map((row) => row.session_id)).toEqual(["good"]);
});

it("fails closed without overwriting a corrupt registry", () => {
  const f = fixture();
  new ConversationHistory(f.options);
  writeFileSync(f.registry(), '{"version":1,"entries":');
  // When a new service reads damaged metadata.
  expect(() => new ConversationHistory(f.options)).toThrow();
  // Then the original damaged bytes remain available for recovery.
  expect(readFileSync(f.registry(), "utf8")).toBe('{"version":1,"entries":');
});

it("rejects an opaque id from another socket and arbitrary filesystem paths", async () => {
  const f = fixture(), path = f.session("scoped");
  const first = new ConversationHistory(f.options);
  const [saved] = await first.list();
  if (!saved) throw new Error("missing fixture");
  const other = new ConversationHistory({ ...f.options, socketPath: join(f.root, "other.sock") });
  // When a request supplies another scope's ID or a path.
  await expect(other.resume(saved.id)).rejects.toMatchObject({ code: "conversation_not_found" });
  await expect(first.read(path)).rejects.toMatchObject({ code: "conversation_not_found" });
  // Then no process is launched.
  expect(f.created).toEqual([]);
});

it("joins concurrent explicit resumes and passes only the validated absolute session path", async () => {
  const f = fixture(), path = f.session("concurrent");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history = new ConversationHistory({ ...f.options, runtime: { ...f.runtime, start: async (paneId, args) => {
    await f.runtime.start(paneId, args);
    entered.resolve();
    await release.promise;
  } } });
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When a second request arrives while the first start is pending.
  const first = history.resume(saved.id);
  await entered.promise;
  const second = history.resume(saved.id);
  release.resolve();
  // Then both requests receive the same owned pane from one launch.
  expect(await first).toEqual(await second);
  expect(f.created).toHaveLength(1);
  expect(f.started).toEqual([{ paneId: "created-0", args: ["--session", path] }]);
}, 5000);

it("reuses an exact live pane rather than typing into it or creating another", async () => {
  const f = fixture(), path = f.session("live");
  f.resolutions.set("existing", { source: "omo-transcript", path });
  f.setSnapshot([pane("existing", f.cwd)]);
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When explicitly resuming an already running exact session.
  const binding = await history.resume(saved.id);
  // Then its pane is returned without any input operation.
  expect(binding).toEqual({ pane_id: "existing", workspace_id: "workspace-existing" });
  expect(f.created).toEqual([]);
  expect(f.started).toEqual([]);
});

it("closes only its owned workspace when startup fails and keeps the saved record", async () => {
  const f = fixture();
  f.session("failed");
  const history = new ConversationHistory({ ...f.options, runtime: { ...f.runtime, start: async () => { throw new Error("start failed"); } } });
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When the trusted launch adapter fails.
  await expect(history.resume(saved.id)).rejects.toMatchObject({ code: "resume_failed" });
  // Then only its own workspace is cleaned and the error survives restart.
  expect(f.closed).toEqual(["workspace-created-0"]);
  expect(await new ConversationHistory(f.options).list()).toMatchObject([{ id: saved.id, error: "start failed" }]);
});

it("refuses a changed native identity before creating a workspace", async () => {
  const f = fixture(), path = f.session("changed");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  writeFileSync(path, JSON.stringify({ type: "session", id: "replacement", cwd: f.cwd }) + "\n");
  // When the saved ID no longer names the header that was recorded.
  await expect(history.resume(saved.id)).rejects.toMatchObject({ code: "conversation_unavailable" });
  // Then no workspace or process is created.
  expect(f.created).toEqual([]);
});

it("refuses resume when the original working directory no longer exists", async () => {
  const f = fixture();
  f.session("cwd-gone");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  rmSync(f.cwd, { recursive: true });
  // When the transcript exists but its working directory does not.
  await expect(history.resume(saved.id)).rejects.toMatchObject({ code: "resume_failed" });
  // Then the conversation stays readable but cannot launch elsewhere.
  expect(f.created).toEqual([]);
  expect(await history.list()).toMatchObject([{ id: saved.id, can_resume: false, state: "closed" }]);
});

it("persists explicit close intent independently of pane disappearance", async () => {
  const f = fixture(), path = f.session("closed");
  f.resolutions.set("a", { source: "omo-transcript", path });
  const history = new ConversationHistory(f.options);
  await history.observe(f.setSnapshot([pane("a", f.cwd)]));
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When the user explicitly closes this conversation.
  await history.setDesiredOpen(saved.id, false);
  await history.observe(f.setSnapshot([]));
  // Then restart does not nominate it for automatic restoration.
  expect(await new ConversationHistory(f.options).restoreTargets()).toEqual([]);
});

it("reads full archived tool output and returns null for unsupported image sources", async () => {
  const f = fixture(), path = f.session("tool-output");
  const output = "full output ".repeat(1000);
  appendFileSync(path, JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: output }] } }) + "\n");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When archived assets are requested without any live pane.
  const result = await history.toolOutput(saved.id, "call-1");
  // Then the original full result is available, with no invented image support.
  expect(result).toBe(output);
  expect(await history.image(saved.id, "pi:call-1:0")).toBeNull();
});

it("reads observed Codex transcripts offline but does not offer an unsupported launch", async () => {
  const f = fixture();
  const path = join(f.options.codexHome, "sessions", "rollout.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "codex-session", cwd: f.cwd } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex history" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  f.resolutions.set("codex", { source: "codex-transcript", path });
  const history = new ConversationHistory(f.options);
  await history.observe(f.setSnapshot([pane("codex", f.cwd)]));
  await history.observe(f.setSnapshot([]));
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When the archived Codex session is requested.
  const conversation = await history.read(saved.id);
  // Then its native messages are read while launch remains explicitly unsupported.
  expect(conversation.source).toBe("codex-transcript");
  expect(conversation.turns[0]?.parts).toEqual([{ kind: "text", text: "codex history" }]);
  expect(saved.can_resume).toBeFalse();
  await expect(history.resume(saved.id)).rejects.toMatchObject({ code: "resume_unsupported" });
});

it("restores only previously open OmO sessions into their original idle pane on a new boot", async () => {
  const f = fixture(), path = f.session("restore");
  f.session("archive-only");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  const restoredPane = { ...pane("original", f.cwd), terminal_id: "new-terminal" };
  // When Herdr restarts with its original pane restored as an idle shell.
  await history.observe(f.setSnapshot([restoredPane]));
  // Then only that previous open session is launched, without creating workspaces.
  expect(f.started).toEqual([{ paneId: "original", args: ["--session", path] }]);
  expect(f.created).toEqual([]);
  expect((await history.restoreTargets()).map((row) => row.session_id)).toEqual(["restore"]);
});

it("does not repeat a recorded automatic launch after a same-boot Web UI restart", async () => {
  const f = fixture(), path = f.session("once");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  const snapshot = f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]);
  await history.observe(snapshot);
  // When another service starts before the launched agent exposes exact ownership.
  const restarted = new ConversationHistory({ ...f.options, autoRestore: true });
  await restarted.observe(snapshot);
  // Then the durable once-per-boot attempt prevents another input command.
  expect(f.started).toHaveLength(1);
});

it("keeps a restored conversation closed when OmO exits before its next transcript observation", async () => {
  const f = fixture(), path = f.session("restore-then-quit");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  const snapshot = f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]);
  await history.observe(snapshot);
  // The start completed, but by the next observation the process has returned to its shell.
  await history.observe(snapshot);
  expect(await history.restoreTargets()).toEqual([]);
  f.setBoot("boot-three");
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "third-terminal" }]));
  expect(f.started).toHaveLength(1);
});

it("replaces the old restore target when the same pane switches conversations", async () => {
  const f = fixture(), first = f.session("before-new"), second = f.session("after-new");
  f.resolutions.set("original", { source: "omo-transcript", path: first });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.set("original", { source: "omo-transcript", path: second });
  f.setBusy(true);
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  expect((await history.restoreTargets()).map((record) => record.session_id)).toEqual(["after-new"]);
  f.resolutions.clear();
  f.setBusy(false);
  f.setBoot("boot-two");
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  expect(f.started).toEqual([{ paneId: "original", args: ["--session", second] }]);
});

it("does not create another manual launch while a prior service's exact session is unconfirmed", async () => {
  const f = fixture();
  f.session("manual-pending");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  const started = await history.resume(saved.id);
  f.setSnapshot([pane(started.pane_id, f.cwd)]);
  f.setBusy(true);
  const restarted = new ConversationHistory(f.options);
  await expect(restarted.resume(saved.id)).rejects.toMatchObject({ code: "conversation_unavailable" });
  expect(f.created).toHaveLength(1);
  expect(f.started).toHaveLength(1);
});

it("can explicitly resume again after a manually opened OmO returns to its shell", async () => {
  const f = fixture();
  f.session("manual-then-quit");
  const history = new ConversationHistory(f.options);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  const started = await history.resume(saved.id);
  await history.observe(f.setSnapshot([pane(started.pane_id, f.cwd)]));
  await history.resume(saved.id);
  expect(f.created).toHaveLength(2);
  expect(f.started).toHaveLength(2);
});

it("preserves a busy restored pane and its error while allowing explicit resume elsewhere", async () => {
  const f = fixture(), path = f.session("busy");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  f.setBusy(true);
  // When the same restored pane already runs an unrelated command.
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  // Then automatic restore touches nothing and retains a visible error and intent.
  expect(f.started).toEqual([]);
  expect(f.created).toEqual([]);
  expect(await history.restoreTargets()).toMatchObject([{ session_id: "busy", error: "original_restore_pane_busy" }]);
});

it("keeps a missing new-boot pane pending and restores it when the original pane appears", async () => {
  const f = fixture(), path = f.session("missing-pane");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  await history.observe(f.setSnapshot([]));
  expect(await history.restoreTargets()).toMatchObject([{ session_id: "missing-pane", error: "original_restore_pane_pending" }]);
  // When a later snapshot finally contains the original restored pane.
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  // Then the pending target launches once without inventing a new workspace.
  expect(f.created).toEqual([]);
  expect(f.started).toEqual([{ paneId: "original", args: ["--session", path] }]);
  expect(await history.restoreTargets()).toMatchObject([{ session_id: "missing-pane", error: null }]);
});

it("does not auto-start when the exact session is already live elsewhere after restart", async () => {
  const f = fixture(), path = f.session("already-restored");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.resolutions.set("elsewhere", { source: "omo-transcript", path });
  f.setBoot("boot-two");
  // When the exact transcript is already attached to another pane on the new boot.
  await history.observe(f.setSnapshot([pane("elsewhere", f.cwd), { ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  // Then that exact live binding wins without another start.
  expect(f.started).toEqual([]);
  expect(await history.list()).toMatchObject([{ session_id: "already-restored", state: "open", pane_id: "elsewhere" }]);
});

it("keeps automatic restoration disabled unless the owner opts in", async () => {
  const f = fixture(), path = f.session("disabled");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory(f.options);
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  // When the service was created without autoRestore.
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  // Then desired-open metadata survives but no process starts.
  expect(f.started).toEqual([]);
  expect(await history.restoreTargets()).toHaveLength(1);
});

it("allows manual resume after automatic restore failed without typing into the busy original", async () => {
  const f = fixture(), path = f.session("manual-recovery");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  f.setBusy(true);
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  // When the user explicitly resumes a failed automatic target.
  const resumed = await history.resume(saved.id);
  // Then it launches in a new owned workspace and never inputs to the busy one.
  expect(resumed.pane_id).toBe("created-0");
  expect(f.started).toEqual([{ paneId: "created-0", args: ["--session", path] }]);
});

it("does not launch an automatic target after stop interrupts its idle-shell check", async () => {
  const f = fixture(), path = f.session("stopped");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history = new ConversationHistory({ ...f.options, autoRestore: true, runtime: { ...f.runtime, processInfo: async (id) => {
    entered.resolve();
    await release.promise;
    return f.runtime.processInfo(id);
  } } });
  f.resolutions.set("original", { source: "omo-transcript", path });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  const observation = history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  await entered.promise;
  // When shutdown occurs while an asynchronous safety check is pending.
  history.stop();
  release.resolve();
  await observation;
  // Then no later input or workspace creation is permitted.
  expect(f.started).toEqual([]);
  expect(f.created).toEqual([]);
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  await expect(history.resume(saved.id)).rejects.toMatchObject({ code: "history_stopped" });
}, 5000);

it("cleans its new workspace without starting an agent when stop races workspace creation", async () => {
  const f = fixture();
  f.session("stop-create");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history = new ConversationHistory({ ...f.options, runtime: { ...f.runtime, create: async (cwd, title) => {
    const binding = await f.runtime.create(cwd, title);
    entered.resolve();
    await release.promise;
    return binding;
  } } });
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  const resumed = history.resume(saved.id);
  await entered.promise;
  // When shutdown precedes the workspace-create response.
  history.stop();
  release.resolve();
  // Then only the operation's unused workspace is closed.
  await expect(resumed).rejects.toMatchObject({ code: "history_stopped" });
  expect(f.started).toEqual([]);
  expect(f.closed).toEqual(["workspace-created-0"]);
}, 5000);

it("serves the exact referenced Codex image after its pane is removed", async () => {
  const f = fixture(), path = join(f.options.codexHome, "sessions", "image.jsonl");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=", "base64");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    { type: "session_meta", payload: { id: "codex-image", cwd: f.cwd } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  f.resolutions.set("codex", { source: "codex-transcript", path });
  const history = new ConversationHistory(f.options);
  await history.observe(f.setSnapshot([pane("codex", f.cwd)]));
  await history.observe(f.setSnapshot([]));
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  const image = (await history.read(saved.id)).turns[0]?.parts.find((part) => part.kind === "image");
  if (!image || image.kind !== "image") throw new Error("missing native image");
  // When its archived image reference is requested.
  const result = await history.image(saved.id, image.ref);
  // Then the original bytes are available without a pane or arbitrary path access.
  expect(result?.mediaType).toBe("image/png");
  expect(result ? Buffer.from(result.bytes) : null).toEqual(png);
  expect(await history.image(saved.id, "../../etc/passwd")).toBeNull();
});

it("does not resurrect a pane closed before a same-boot Web UI restart", async () => {
  const f = fixture(), path = f.session("deliberately-closed");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  history.stop();
  f.resolutions.clear();
  const restarted = new ConversationHistory({ ...f.options, autoRestore: true });
  // When the bridge returns on the same boot after the pane was closed.
  await restarted.observe(f.setSnapshot([]));
  // Then no future Herdr restart may restore this deliberately closed target.
  expect(await restarted.restoreTargets()).toEqual([]);
  expect(f.started).toEqual([]);
});

it("refuses a shell running a command even when it still owns the foreground pid", async () => {
  const f = fixture(), path = f.session("shell-command");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true, runtime: { ...f.runtime,
    processInfo: async () => ({ shell_pid: 10, foreground_processes: [{ pid: 10, argv: ["/bin/zsh", "-c", "read value"] }] }),
  } });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  // When the restored terminal runs a shell script rather than an idle interactive shell.
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  // Then no command is injected into the running script.
  expect(f.started).toEqual([]);
  expect(await history.list()).toMatchObject([{ error: "original_restore_pane_busy" }]);
});

it("retains last-open intent through transient live-resolution failures", async () => {
  const f = fixture(), path = f.session("transient");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory(f.options);
  const snapshot = f.setSnapshot([pane("original", f.cwd)]);
  await history.observe(snapshot);
  f.resolutions.clear();
  f.setBusy(true);
  // When a present, non-idle pane temporarily cannot resolve its transcript.
  await history.observe(snapshot);
  // Then missing evidence cannot erase the last known restoration intent.
  expect(await history.restoreTargets()).toHaveLength(1);
});

it("refreshes a queued snapshot so manual resume cannot be closed by stale observation", async () => {
  const f = fixture(), path = f.session("queued-observation");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const history = new ConversationHistory({ ...f.options, runtime: { ...f.runtime, start: async (id, args) => {
    await f.runtime.start(id, args);
    f.resolutions.set(id, { source: "omo-transcript", path });
    f.setSnapshot([pane(id, f.cwd)]);
    entered.resolve();
    await release.promise;
  } } });
  const [saved] = await history.list();
  if (!saved) throw new Error("missing fixture");
  const resumed = history.resume(saved.id);
  await entered.promise;
  // When an older snapshot queues behind a pending resume.
  const observed = history.observe(empty());
  release.resolve();
  await resumed;
  await observed;
  // Then the actual new live session, not the stale empty snapshot, owns the record.
  expect(await history.list()).toMatchObject([{ id: saved.id, state: "open", pane_id: "created-0" }]);
  expect(await history.restoreTargets()).toHaveLength(1);
}, 5000);

it.each(["opencode-transcript", "devin-transcript"] as const)("does not archive a %s database as a transcript file", async (source) => {
  const f = fixture();
  const database = join(f.root, "native.db");
  writeFileSync(database, "not a JSONL transcript");
  const history = new ConversationHistory({ ...f.options, runtime: { ...f.runtime,
    resolve: async () => ({ source, path: database }),
  } });
  await history.observe(f.setSnapshot([pane("db", f.cwd)]));
  expect(await history.list()).toEqual([]);
  expect(f.started).toEqual([]);
});

it("keeps OpenCode's database as resolveTranscript's fifth argument", async () => {
  const f = fixture();
  const current: HerdrPane = { ...pane("db", f.cwd), agent: "opencode",
    agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_example" } };
  const database = join(f.root, "opencode.db");
  const resolved = await resolveTranscript(current, f.cwd, f.options.codexHome, [current], database,
    { agentDir: f.options.omoHome, exactOnly: true });
  expect(resolved).toEqual({ source: "opencode-transcript", path: database, session: "ses_example" });
});

it("refuses automatic input when an idle shell holds a draft", async () => {
  const f = fixture(), path = f.session("draft");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true,
    runtime: { ...f.runtime, inputIdle: async () => false } });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  await history.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  expect(f.started).toEqual([]);
  expect(await history.list()).toMatchObject([{ error: "original_restore_input_busy" }]);
});

it("persists a confirmed close before the next snapshot or daemon restart", async () => {
  const f = fixture(), path = f.session("event-close");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  await history.closePane("original");
  history.stop();
  f.resolutions.clear();
  f.setBoot("boot-two");
  const restarted = new ConversationHistory({ ...f.options, autoRestore: true });
  await restarted.observe(f.setSnapshot([{ ...pane("original", f.cwd), terminal_id: "new-terminal" }]));
  expect(f.started).toEqual([]);
  expect(await restarted.restoreTargets()).toEqual([]);
});

it("keeps a previous boot's restore intent when the collector reports its missing pane", async () => {
  const f = fixture(), path = f.session("restart-end");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  await history.observe(f.setSnapshot([pane("original", f.cwd)]));
  f.setBoot("boot-two");
  await history.closePane("original");
  expect(await history.restoreTargets()).toHaveLength(1);
});

it.each(["terminal", "workspace", "cwd"] as const)("refuses automatic restore after mismatched %s evidence", async (mismatch) => {
  const f = fixture(), path = f.session("ownership");
  f.resolutions.set("original", { source: "omo-transcript", path });
  const history = new ConversationHistory({ ...f.options, autoRestore: true });
  const original = pane("original", f.cwd);
  await history.observe(f.setSnapshot([original]));
  f.resolutions.clear();
  f.setBoot("boot-two");
  const changed = { ...original, terminal_id: "new-terminal" };
  if (mismatch === "terminal") changed.terminal_id = original.terminal_id;
  if (mismatch === "workspace") changed.workspace_id = "another-workspace";
  if (mismatch === "cwd") changed.cwd = join(f.root, "another-project");
  await history.observe(f.setSnapshot([changed]));
  expect(f.started).toEqual([]);
  expect(f.created).toEqual([]);
});
