/**
 * What only a real Windows PC can show: its process table as PowerShell answers it, and a
 * session store on its own file system with its own path rules. Everything else about the
 * Windows branches is tested with rows and paths handed in (gjc-runtime.test.ts); these run
 * on the Windows runner of reusable CI.
 */
import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProcessSession, forgetClaudeSessions, processClaudeConfigDir } from "./claude-store.ts";
import { Database } from "bun:sqlite";

import { codexRolloutPath, directoryKey, sameDirectory, storedCwdCondition } from "./codex.ts";
import { gjcSessionFile, storeRelative } from "./gjc-runtime.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";

const onWindows = process.platform === "win32";

it.skipIf(!onWindows)("reads this PC's process table: this process, its parent, when it started and what it runs", async () => {
  const rows = await windowsProcessTable(30_000);
  const self = rows.find((row) => row.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.parent).toBe(process.ppid);
  // ms since 1970, as Date.now() counts: started before now, and not a day ago
  expect(typeof self!.started).toBe("number");
  expect(self!.started!).toBeLessThanOrEqual(Date.now() + 2000);
  expect(self!.started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  expect((self!.path ?? "").toLowerCase()).toContain("bun");
  // found from its parent the way a pane's program is found from the pane's shell
  expect(descendantArgv(rows, process.ppid).some((argv) => (argv[0] ?? "").toLowerCase() === (self!.path ?? "").toLowerCase())).toBe(true);
}, 40_000);

it.skipIf(!onWindows)("keeps a session file inside its store on a real Windows file system", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-native-")));
  try {
    const root = join(home, ".gjc", "agent", "sessions");
    const store = join(root, "v2-project");
    mkdirSync(join(store, "2026-10-01_session"), { recursive: true });
    const session = join(store, "2026-10-01_session.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(join(store, "2026-10-01_session", "task.jsonl"), "{}\n");
    expect(root).toContain("\\");
    expect(gjcSessionFile(root, session)).toBe(session);
    // the drive letter's case is not another place, and a subagent's file stands for its session
    const lower = session[0]!.toLowerCase() + session.slice(1);
    const upper = session[0]!.toUpperCase() + session.slice(1);
    expect(gjcSessionFile(root, lower)).toBe(lower);
    expect(gjcSessionFile(root, upper)).toBe(upper);
    expect(gjcSessionFile(root, join(store, "2026-10-01_session", "task.jsonl"))).toBe(session);
    expect(storeRelative(root, session)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
    for (const outside of [`${root}-evil\\v2-project\\session.jsonl`, `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`, `\\\\server\\share\\session.jsonl`, root]) {
      expect(storeRelative(root, outside)).toBeNull();
      expect(gjcSessionFile(root, outside)).toBeNull();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("reads a Codex rollout path stored with the \\\\?\\ prefix, and still keeps it inside the store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-native-")));
  try {
    const home = join(root, "With Spaces", ".codex");
    const day = join(home, "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    // as Codex on Windows writes `threads.rollout_path`
    expect(codexRolloutPath(`\\\\?\\${path}`, home)).toBe(path);
    expect(codexRolloutPath(path, home)).toBe(path);
    expect(codexRolloutPath(`\\\\?\\${outside}`, home)).toBeNull();
    // raw `..` segments (join would fold them) that climb from the store to `outside`, which exists
    expect(codexRolloutPath(`\\\\?\\${home}\\sessions\\..\\..\\..\\other.jsonl`, home)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("finds Codex's thread under the on-disk casing when herdr reports another spelling of the directory (#740)", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "herdr-codex-cwd-")));
  mkdirSync(join(root, "Recorde"));
  const reported = join(root, "recorde");
  const canonical = realpathSync.native(reported);
  const db = new Database(":memory:");
  try {
    // the two spellings are only one directory to the file system, not to directoryKey
    expect(directoryKey(reported)).not.toBe(directoryKey(canonical));
    db.run("CREATE TABLE threads (id TEXT, cwd TEXT)");
    db.run("INSERT INTO threads VALUES (?, ?)", ["own", `\\\\?\\${canonical}`]);
    const { where, params } = storedCwdCondition(reported);
    expect(db.query<{ id: string }, string[]>(`SELECT id FROM threads WHERE ${where}`).all(...params)).toEqual([{ id: "own" }]);
    expect(sameDirectory(reported, canonical)).toBe(true);
    mkdirSync(join(root, "Other"));
    expect(sameDirectory(reported, join(root, "Other"))).toBe(false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("finds a Claude's own store from the start it records, which the process table repeats", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-claude-native-")));
  const serverConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  try {
    const session = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";
    // Claude records its start as FILETIME ticks, as PowerShell gives them
    const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`], { stdin: "ignore", stderr: "ignore" });
    const procStart = probe.stdout.toString().trim();
    expect(procStart).toMatch(/^\d+$/);
    const user = join(home, "User With Spaces");
    const store = join(user, ".claude-second");
    mkdirSync(join(store, "sessions"), { recursive: true });
    mkdirSync(join(user, ".claude", "sessions"), { recursive: true });
    const record = (start: string) => writeFileSync(join(store, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: session, procStart: start, kind: "interactive" }));
    // a millisecond off is another process that had this PID
    record(String(BigInt(procStart) + 10_000n));
    expect(await claudeProcessSession(user, process.pid, store)).toBeNull();
    record(procStart);
    expect(await claudeProcessSession(user, process.pid, store)).toBe(session);
    expect(await processClaudeConfigDir(process.pid, [process.execPath], user)).toBe(store);
  } finally {
    forgetClaudeSessions();
    if (serverConfigDir !== undefined) process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    rmSync(home, { recursive: true, force: true });
  }
});
