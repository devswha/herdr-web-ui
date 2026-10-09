import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConversationHistory } from "./conversation-history.ts";
import { HerdrError, herdrRpc, herdrSocketPath, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { startShellAgent } from "./shell-agent.ts";
import { createServer } from "./index.ts";
import { UsageService } from "./usage.ts";

/** Event-driven readiness: the watcher is installed before starting either agent. */
function launchesChanged(directory: string, count: number) {
  const signal = Promise.withResolvers<void>();
  const watcher = watch(directory, () => {
    if (readdirSync(directory).filter((name) => name.endsWith(".json")).length >= count) signal.resolve();
  });
  const timer = setTimeout(() => signal.reject(new Error(`agent launch ${count} evidence timed out`)), 15_000);
  const done = signal.promise.finally(() => { clearTimeout(timer); watcher.close(); });
  return { done, close: () => { clearTimeout(timer); watcher.close(); } };
}

/** The server announces readiness after opening its API, with no test polling. */
async function restartOwnedHerdr(binary: string, session: string, environment: Record<string, string | undefined>): Promise<ReturnType<typeof Bun.spawn>> {
  const socket = herdrSocketPath();
  const gone = Promise.withResolvers<void>();
  const watcher = watch(dirname(socket), () => { if (!existsSync(socket)) gone.resolve(); });
  const stopTimer = setTimeout(() => gone.reject(new Error("Herdr socket removal timed out")), 15_000);
  const stopped = Bun.spawn([binary, "--session", session, "server", "stop"], { stdout: "pipe", stderr: "pipe", env: environment });
  try {
    if (await stopped.exited !== 0) throw new Error(await new Response(stopped.stderr).text());
    if (!existsSync(socket)) gone.resolve();
    await gone.promise;
  } finally { clearTimeout(stopTimer); watcher.close(); }
  return startOwnedHerdr(binary, session, environment);
}
async function startOwnedHerdr(binary: string, session: string, environment: Record<string, string | undefined>): Promise<ReturnType<typeof Bun.spawn>> {
  const server = Bun.spawn([binary, "--session", session, "server"], {
    stdout: "pipe", stderr: "pipe",
    env: environment,
  });
  const ready = Promise.withResolvers<void>();
  let text = "";
  const timer = setTimeout(() => { server.kill(); ready.reject(new Error(`Herdr restart timed out: ${text}`)); }, 15_000);
  void server.exited.then((code) => ready.reject(new Error(`Herdr exited (${code}) before readiness: ${text}`)));
  const readers = [server.stdout.getReader(), server.stderr.getReader()];
  try {
    for (const reader of readers) void (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        text += new TextDecoder().decode(chunk.value);
        if (text.includes("api socket:")) { ready.resolve(); return; }
      }
    })().catch(ready.reject);
    await ready.promise;
  } finally { clearTimeout(timer); }
  return server;
}

it("restores exact history through a real owned Herdr restart without touching other panes", async () => {
  // Given an exclusively owned named Herdr session and a local stand-in OmO executable.
  // The executable publishes native holder metadata but never contacts an AI service.
  const binary = Bun.which("herdr");
  if (!binary) throw new Error("herdr is required for this contract");
  // macOS Unix-domain socket paths have only 104 bytes, including the config directory.
  const testSession = `hh-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const originalSession = process.env["HERDR_TEST_SESSION"], originalSocket = process.env["HERDR_SOCKET"];
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "hh-")));
  const socket = join(root, "config", "herdr", "sessions", testSession, "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true });
  process.env["HERDR_TEST_SESSION"] = testSession;
  process.env["HERDR_SOCKET"] = socket;
  const bin = join(root, "bin"), cwd = join(root, "project"), launches = join(root, "launches");
  const omoHome = join(root, "omo"), stateDir = join(root, "state");
  for (const directory of [bin, cwd, launches, join(root, "home")]) mkdirSync(directory);
  writeFileSync(join(root, "home", ".zshrc"), "PS1='$ '\n");
  const id = "contract-session";
  const sessions = join(omoHome, "sessions", `-${cwd.replaceAll("/", "-")}--`);
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, `2026-10-08T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id, cwd, timestamp: "2026-10-08T00:00:00Z" },
    { type: "session_info", name: "owned restart contract" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "persist this exact conversation" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const executable = join(bin, "omo");
  writeFileSync(executable, `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const file = process.argv[process.argv.indexOf("--session") + 1];
const header = JSON.parse(readFileSync(file, "utf8").split("\\n")[0]);
const holders = join(dirname(file), "session-holders", encodeURIComponent(header.id));
mkdirSync(holders, { recursive: true });
writeFileSync(join(holders, process.pid + ".json"), JSON.stringify({pid:process.pid,processStartedAtMs:Date.now(),cwd:header.cwd}));
writeFileSync(join(${JSON.stringify(launches)}, process.pid + ".json"), JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));
for await (const chunk of Bun.stdin.stream()) { if (chunk.length === 0) break; }
`);
  chmodSync(executable, 0o700);
  const originalPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HERDR|OMO|SENPI|PI)_/.test(key))),
    HOME: join(root, "home"), ZDOTDIR: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "data"),
    OMO_CODING_AGENT_DIR: omoHome, PS1: "$ ",
  };
  let owned: string | undefined;
  let initial: ReturnType<typeof Bun.spawn> | undefined;
  let restarted: ReturnType<typeof Bun.spawn> | undefined;
  let firstLaunch: ReturnType<typeof launchesChanged> | undefined;
  let secondLaunch: ReturnType<typeof launchesChanged> | undefined;
  let bridge: ReturnType<typeof createServer> | undefined;
  try {
    initial = await startOwnedHerdr(binary, testSession, environment);
    const created = await workspaceCreate({ cwd, label: "history-owned-restart" });
    owned = created.workspace.workspace_id;
    firstLaunch = launchesChanged(launches, 1);
    try {
      await Promise.all([firstLaunch.done, startShellAgent("omo", created.root_pane.pane_id, ["--session", path], { timeoutMs: 10_000 })]);
    } catch (error) {
      const screen = await herdrRpc("pane.read", { pane_id: created.root_pane.pane_id, source: "visible", format: "text" });
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${JSON.stringify(screen)}`);
    }
    const history = new ConversationHistory({ stateDir, omoHome, autoRestore: true });
    const before = await sessionSnapshot();
    await history.observe(before);
    const [saved] = await history.list();
    if (!saved) throw new Error("the real pane was not resolved");
    expect(saved).toMatchObject({ pane_id: created.root_pane.pane_id, state: "open" });
    const oldTerminal = before.panes.find((pane) => pane.pane_id === created.root_pane.pane_id)?.terminal_id;
    bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir,
      conversationHistory: history, autoRestoreAgents: true, usage: new UsageService(undefined, []) });

    // The actual bridge and collector stay alive while Herdr exits and restores its pane.
    secondLaunch = launchesChanged(launches, 2);
    restarted = await restartOwnedHerdr(binary, testSession, environment);
    await initial.exited;
    const snapshot = await sessionSnapshot(herdrSocketPath());
    const restoredPane = snapshot.panes.find((pane) => pane.pane_id === created.root_pane.pane_id);
    expect(restoredPane?.terminal_id).not.toBe(oldTerminal);
    await secondLaunch.done;
    bridge.stop();
    await history.list(); // all in-flight bridge observations have settled before reopening the registry
    const restored = new ConversationHistory({ stateDir, omoHome, autoRestore: true });
    await restored.observe(await sessionSnapshot());

    // Then it resumes the exact file in the same public pane and exposes durable messages.
    expect(readdirSync(launches).map((file) => JSON.parse(readFileSync(join(launches, file), "utf8")))).toEqual([
      { args: ["--session", path], cwd }, { args: ["--session", path], cwd },
    ]);
    await restored.observe(await sessionSnapshot());
    expect(await restored.list()).toMatchObject([{ id: saved.id, pane_id: created.root_pane.pane_id, state: "open" }]);
    expect((await restored.read(saved.id)).turns[0]?.parts).toEqual([{ kind: "text", text: "persist this exact conversation" }]);
    expect((await sessionSnapshot()).workspaces.filter((workspace) => workspace.label === "history-owned-restart")).toHaveLength(1);
  } finally {
    bridge?.stop();
    firstLaunch?.close(); secondLaunch?.close();
    if (originalPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = originalPath;
    try { if (owned) await workspaceClose(owned); }
    catch (error) {
      if (!(error instanceof HerdrError) || !["server_unavailable", "connect_failed", "closed"].includes(error.code)) throw error;
    }
    finally {
      const stop = Bun.spawn([binary, "--session", testSession, "server", "stop"], { stdout: "ignore", stderr: "ignore", env: environment });
      await stop.exited;
      if (restarted) await restarted.exited;
      else if (initial) await initial.exited;
      if (originalSession === undefined) delete process.env["HERDR_TEST_SESSION"]; else process.env["HERDR_TEST_SESSION"] = originalSession;
      if (originalSocket === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = originalSocket;
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 60_000);
