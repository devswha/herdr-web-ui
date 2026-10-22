import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { terminalBreadcrumb } from "./gjc-runtime.ts";
import { isOmpProcess, ompAgentDir, ompHeldTranscript, ompLaunch } from "./omp.ts";
import * as ompProbe from "./omp-process.ts";
import * as omo from "./omo.ts";

it("recognizes native and interpreter-launched omp, not look-alikes", () => {
  expect(isOmpProcess(["omp", "--profile", "personal", "--resume"])).toBe(true);
  expect(isOmpProcess(["/home/u/.local/bin/omp"])).toBe(true);
  expect(isOmpProcess(["bun", "/opt/omp/dist/omp.js"])).toBe(true);
  expect(isOmpProcess(["C:\\Users\\u\\bin\\omp.exe"])).toBe(true);
  expect(isOmpProcess(["omo"])).toBe(false);
  expect(isOmpProcess(["omp-helper"])).toBe(false);
  expect(isOmpProcess(["node", "/tmp/omp/server.js"])).toBe(false);
  expect(isOmpProcess([])).toBe(false);
});

it("keeps a process's sessions where its profile puts them, and nowhere it cannot tell", () => {
  const home = "/home/u";
  expect(ompAgentDir(["omp", "--continue"], null, home)).toBe("/home/u/.omp/agent");
  expect(ompAgentDir(["omp", "--profile", "personal", "--resume"], null, home)).toBe("/home/u/.omp/profiles/personal/agent");
  expect(ompAgentDir(["omp", "--profile=work"], null, home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["PATH=/bin", "OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/personal/agent");
  // the flag wins over the environment; an empty variable is no profile
  expect(ompAgentDir(["omp", "--profile", "work"], ["OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["OMP_PROFILE="], home)).toBe("/home/u/.omp/agent");
  // a store moved anywhere, or a name that leaves the profiles folder, is not trusted
  expect(ompAgentDir(["omp", "--session-dir", "/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--session-dir=/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", ".."], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", "a/../../x"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile"], null, home)).toBeNull();
  // a cwd option without its value leaves omp's directory unknown
  expect(ompAgentDir(["omp", "--cwd"], null, home)).toBeNull();
});

it("reads omp's cwd and store options from its argv the way omp does", () => {
  const cases: [string[], { profile: string | null; sessionDir: boolean; cwd: string | null } | null][] = [
    [["omp"], { profile: null, sessionDir: false, cwd: null }],
    // split and equal forms, the last one winning
    [["omp", "--cwd", "/a", "--cwd=/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd=/b", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd", "/a", "--profile=work", "--cwd", "rel/dir", "--profile", "home"], { profile: "home", sessionDir: false, cwd: "rel/dir" }],
    // nothing after the terminator is an option
    [["omp", "--cwd", "/a", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--", "--cwd=/b", "--session-dir", "/s"], { profile: null, sessionDir: false, cwd: null }],
    // paths with spaces and shell metacharacters are literal words of argv
    [["omp", "--cwd", "/p/with space/$(rm -rf x);*|`y`"], { profile: null, sessionDir: false, cwd: "/p/with space/$(rm -rf x);*|`y`" }],
    [["omp", "--cwd=/a=b c"], { profile: null, sessionDir: false, cwd: "/a=b c" }],
    // an option's value is consumed with it, even one that looks like an option
    [["omp", "--cwd", "--profile", "work"], { profile: null, sessionDir: false, cwd: "--profile" }],
    [["omp", "--model", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--system-prompt", "--cwd=/a", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    // an optional value is never an option
    [["omp", "--resume", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--plan", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "-r", "abc", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    // a message that mentions the option is one word, not the option
    [["omp", "fix --cwd /x", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    // interpreter-launched: options start after omp's script
    [["bun", "/opt/omp/dist/omp.js", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--session-dir=/s", "--cwd", "/a"], { profile: null, sessionDir: true, cwd: "/a" }],
    // a missing or empty value, last or not, leaves the directory unknown
    [["omp", "--cwd"], null],
    [["omp", "--cwd="], null],
    [["omp", "--cwd", ""], null],
    [["omp", "--cwd", "/a", "--cwd="], null],
    [["omp", "--cwd=", "--cwd", "/a"], null],
    [["omp", "--profile="], null],
  ];
  for (const [argv, expected] of cases) expect([argv, ompLaunch(argv)]).toEqual([argv, expected]);
});

it("reads omp's breadcrumb, whose transcript starts with a title record before the header", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omp-breadcrumb-")));
  try {
    const agent = join(home, ".omp/profiles/personal/agent");
    const store = join(agent, "sessions/-project"), markers = join(agent, "terminal-sessions");
    mkdirSync(join(store, "2026-10-04_session"), { recursive: true }); mkdirSync(markers);
    const session = join(store, "2026-10-04_session.jsonl"), advisor = join(store, "2026-10-04_session", "__advisor.scribe.jsonl");
    const records = [{ type: "title", v: 1, title: "Fix the metrics", pad: " ".repeat(120) }, { type: "session", version: 3, cwd: home }];
    writeFileSync(session, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(advisor, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    // omp's breadcrumb carries more lines than the cwd and the path
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\nfresh\ncwdstat 1 2\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    // an advisor's file stands for the session it runs in
    writeFileSync(join(markers, "pts-7"), `${home}\n${advisor}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    // a title with no header after it is not a transcript
    writeFileSync(session, JSON.stringify(records[0]) + "\n");
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

describe("an omp pane's chat", () => {
  let home = "";
  let savedHome: string | undefined;
  let agentSession: unknown;
  let processes: { pid: number; name?: string; argv?: string[] }[] = [];
  let groupId: number | undefined;
  let pane: HerdrPane;
  const restores: Array<() => void> = [];
  const transcript = (cwd: string) => [
    JSON.stringify({ type: "title", v: 1, title: "t" }),
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "synthetic question" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } }),
  ].join("\n") + "\n";

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omp-pane-")));
    savedHome = process.env["HOME"];
    process.env["HOME"] = home;
    const cwd = join(home, "project");
    mkdirSync(cwd);
    pane = { pane_id: "pane-omp", cwd, foreground_cwd: cwd, agent: "omp" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method === "agent.get") return { agent: { agent_session: agentSession } } as never;
      if (method === "pane.process_info") return { process_info: { foreground_processes: processes, foreground_process_group_id: groupId } } as never;
      throw new Error(`unexpected RPC: ${method}`);
    });
    restores.push(() => snapshot.mockRestore(), () => rpc.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
    agentSession = undefined;
    processes = [];
    groupId = undefined;
    forgetTranscriptState();
  });

  /** A transcript in the default store whose header names `cwd`, from a session directory named after it. */
  const storeTranscript = (cwd: string, name = "2026-10-01_s1.jsonl") => {
    const store = join(home, ".omp/agent/sessions", cwd.replaceAll("/", "-"));
    mkdirSync(store, { recursive: true });
    const path = join(store, name);
    writeFileSync(path, transcript(cwd));
    return path;
  };
  /**
   * An omp stand-in that holds `held` open, started in `cwd` (through a wrapper that changes to
   * `wrapperCd` first, when given), answering once it is ready. Killed and reaped after the test.
   */
  const standIn = async (options: string[], held: string[], { cwd, wrapperCd, env }: { cwd?: string; wrapperCd?: string; env?: Record<string, string> } = {}) => {
    const script = join(home, "bin", "omp.js");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(script, `for (const file of ${JSON.stringify(held)}) require("node:fs").openSync(file, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...options];
    const command = wrapperCd === undefined ? argv : ["sh", "-c", 'cd "$1" && shift && exec "$@"', "sh", wrapperCd, ...argv];
    const child = Bun.spawn(command, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    reaped.push(async () => { child.kill(); await child.exited; });
    const first = await Promise.race([
      child.stdout.getReader().read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    return { pid: child.pid, argv };
  };
  const reaped: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const reap of reaped.splice(0)) await reap(); });
  const chat = async () => {
    forgetTranscriptState();
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    return answer.turns.map((turn) => turn.parts[0]);
  };
  const synthetic = [{ kind: "text" as const, text: "synthetic question" }, { kind: "text" as const, text: "synthetic answer" }];

  it.skipIf(process.platform !== "linux")("held OMP uses the last cwd before the terminator", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const path = storeTranscript(target);
    // a more recent session of the pane's own directory is no answer for this process
    storeTranscript(pane.cwd!, "2026-10-02_decoy.jsonl");
    for (const options of [
      ["--cwd", "/elsewhere", `--cwd=${target}`],
      ["--cwd=/elsewhere", "--cwd", `${target}/`, "--", "--cwd", pane.cwd!],
    ]) {
      const omp = await standIn(options, [path]);
      processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        expect(await chat()).toEqual(synthetic);
      }
      for (const reap of reaped.splice(0)) await reap();
    }
    // the same through the terminal breadcrumb of a process that holds nothing open
    const omp = await standIn(["--cwd", "/elsewhere", `--cwd=${target}`], [], { env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4243" } });
    mkdirSync(join(home, ".omp/agent/terminal-sessions"));
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4243"), `${target}\n${path}\n`);
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    expect(await chat()).toEqual(synthetic);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
  });

  it.skipIf(process.platform !== "linux")("missing cwd operand cannot select a transcript", async () => {
    // the pane's own directory holds the session the process has open, and so does B's
    const path = storeTranscript(pane.cwd!);
    const b = join(home, "B");
    mkdirSync(b);
    const pathB = storeTranscript(b);
    for (const options of [["--cwd"], ["--cwd="], ["--cwd", ""], ["--cwd", pane.cwd!, "--cwd="], ["--cwd", "", b]]) {
      const omp = await standIn(options, [path, pathB]);
      // herdr's argv, and none (WSL), where the empty operand is read back from procfs
      for (const argv of [omp.argv, undefined]) {
        processes = [{ pid: omp.pid, name: "omp", argv }];
        forgetTranscriptState();
        await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
        expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
      }
      for (const reap of reaped.splice(0)) await reap();
    }
  });

  it.skipIf(process.platform !== "linux")("conflicting OMP routing tuples fail closed", async () => {
    const b = join(home, "B"), c = join(home, "C");
    mkdirSync(b); mkdirSync(c);
    const pathB = storeTranscript(b), pathC = storeTranscript(c);
    // a decoy recent transcript of the pane's directory, held open too
    const decoy = storeTranscript(pane.cwd!, "2026-10-02_decoy.jsonl");
    const first = await standIn(["--cwd", b], [pathB, decoy]);
    const second = await standIn([`--cwd=${c}`], [pathC, decoy]);
    processes = [{ pid: first.pid, name: "omp", argv: first.argv }, { pid: second.pid, name: "omp", argv: second.argv }];
    groupId = first.pid;
    const opened = spyOn(fs, "openSync");
    restores.push(() => opened.mockRestore());
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    // two relative values resolved against two proven directories disagree just the same
    const a = join(home, "A");
    mkdirSync(join(a, "rel"), { recursive: true });
    const pathA = storeTranscript(join(a, "rel"));
    const third = await standIn(["--cwd", "rel"], [pathA, decoy], { cwd: a });
    const fourth = await standIn(["--cwd", "rel"], [decoy], { cwd: pane.cwd! });
    processes = [{ pid: third.pid, name: "omp", argv: third.argv }, { pid: fourth.pid, name: "omp", argv: fourth.argv }];
    groupId = third.pid;
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, { relativeCwd: true, foregroundCwd: a })).toBeNull();
    // an empty final operand on one of them fails the same way
    processes = [{ pid: first.pid, name: "omp", argv: first.argv }, { pid: second.pid, name: "omp", argv: [...second.argv, "--cwd="] }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    // nothing was read from any candidate, the decoy of the pane's directory least of all
    expect(opened.mock.calls.some(([file]) => [pathA, pathB, pathC, decoy].includes(String(file)))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("relative OMP cwd resolves against its proven process cwd", async () => {
    const a = join(home, "A"), stale = join(home, "Y");
    mkdirSync(join(a, "rel"), { recursive: true }); mkdirSync(join(stale, "rel"), { recursive: true });
    const path = storeTranscript(join(a, "rel")), decoy = storeTranscript(join(stale, "rel"));
    const omp = await standIn(["--cwd", "rel"], [path, decoy], { cwd: a });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.cwd = stale; pane.foreground_cwd = stale;
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBe(path);
    // the same through herdr's foreground cwd, when herdr names this process the foreground one
    const probe = spyOn(ompProbe, "ompProcessCwd");
    restores.push(() => probe.mockRestore());
    groupId = omp.pid;
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: a })).toBe(path);
    expect(probe).not.toHaveBeenCalled();
    // shipped off: omp changes into its --cwd, so its directory proves no base
    expect(await ompHeldTranscript(pane.pane_id, stale, { foregroundCwd: a })).toBeNull();
    await expect(chat()).rejects.toThrow("no_session_path");
  });

  it.skipIf(process.platform !== "linux")("wrapper cd wins over stale pane cwd", async () => {
    const x = join(home, "X"), stale = join(home, "Y");
    mkdirSync(join(x, "rel"), { recursive: true }); mkdirSync(join(stale, "rel"), { recursive: true });
    const path = storeTranscript(join(x, "rel")), decoy = storeTranscript(join(stale, "rel"));
    const omp = await standIn(["--cwd", "rel"], [path, decoy], { cwd: stale, wrapperCd: x });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBe(path);
  });

  it.skipIf(process.platform !== "linux")("foreground cwd requires the identified OMP pid", async () => {
    const a = join(home, "A"), stale = join(home, "Y");
    mkdirSync(join(a, "rel"), { recursive: true }); mkdirSync(join(stale, "rel"), { recursive: true });
    const path = storeTranscript(join(a, "rel")), decoy = storeTranscript(join(stale, "rel"));
    const omp = await standIn(["--cwd", "rel"], [path, decoy], { cwd: a });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    const probe = spyOn(ompProbe, "ompProcessCwd");
    restores.push(() => probe.mockRestore());
    // herdr's foreground process is another one: its directory is not omp's, the probe answers
    for (const other of [process.pid, undefined]) {
      groupId = other;
      probe.mockClear();
      expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBe(path);
      expect(probe).toHaveBeenCalledWith(omp.pid);
    }
    // herdr names omp, but a second omp runs in the pane: no single owner of that directory
    groupId = omp.pid;
    const second = await standIn(["--cwd", "rel"], [path], { cwd: a });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }, { pid: second.pid, name: "omp", argv: second.argv }];
    probe.mockClear();
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBe(path);
    expect(probe).toHaveBeenCalledWith(omp.pid);
    // herdr's directory must be absolute
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    probe.mockClear();
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: "Y" })).toBe(path);
    expect(probe).toHaveBeenCalledWith(omp.pid);
  });

  it.skipIf(process.platform !== "linux")("unreadable or Windows process cwd refuses relative values", async () => {
    const stale = join(home, "Y");
    mkdirSync(join(stale, "rel"), { recursive: true });
    const decoy = storeTranscript(join(stale, "rel"));
    const omp = await standIn(["--cwd", "rel"], [decoy], { cwd: stale });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    groupId = process.pid;
    // the probe cannot read the directory (procfs denial, lsof without one answer, a reused pid)
    const probe = spyOn(ompProbe, "ompProcessCwd").mockResolvedValue(null);
    restores.push(() => probe.mockRestore());
    expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBeNull();
    expect(probe).toHaveBeenCalledWith(omp.pid);
    // Windows: no process directory is read, and herdr's is no proof either
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      probe.mockClear();
      groupId = omp.pid;
      expect(await ompHeldTranscript(pane.pane_id, stale, { relativeCwd: true, foregroundCwd: stale })).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it.skipIf(process.platform !== "linux")("absolute OMP cwd needs no readable process cwd", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const path = storeTranscript(target);
    const omp = await standIn(["--cwd", "rel", "--cwd", target], [path]);
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    const probe = spyOn(ompProbe, "ompProcessCwd").mockResolvedValue(null);
    restores.push(() => probe.mockRestore());
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, { relativeCwd: true })).toBe(path);
    expect(await chat()).toEqual(synthetic);
    expect(probe).not.toHaveBeenCalled();
  });

  it("reads the transcript herdr names in an `omp --profile` store", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    agentSession = { agent: "omp", kind: "path", value: path };
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
    ]);
  });

  it("refuses a transcript in an omp profile store that links outside it", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const outside = join(home, "elsewhere.jsonl");
    writeFileSync(outside, transcript(pane.cwd!));
    const path = join(store, "2026-10-01_s1.jsonl");
    symlinkSync(outside, path);
    agentSession = { agent: "omp", kind: "path", value: path };
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it("leaves an unwritten session's model unknown without reading its status line", async () => {
    // omp names its file at start and writes it with the first answer; `/switch` writes nothing
    const store = join(home, ".omp/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    agentSession = { agent: "omp", kind: "path", value: join(store, "2026-10-19_s2.jsonl") };
    const read = spyOn(herdr, "paneRead");
    restores.push(() => read.mockRestore());
    const started = await paneConversation(pane.pane_id);
    expect(started).toMatchObject({ source: "omp-transcript", turns: [], metadata: { model: null, reasoning_effort: null } });
    expect(started.screen).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("reads the transcript the pane's omp process holds open when herdr names none", async () => {
    const store = join(home, ".omp/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, argv: [process.execPath, script] }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        forgetTranscriptState();
        const answer = await paneConversation(pane.pane_id);
        expect(answer.source).toBe("omp-transcript");
        expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
          { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
        ]);
      }
    } finally { child.kill(); await child.exited; }
  });

  for (const [profile, includeArgv] of [["personal", true], [null, false], ["personal", false]] as const) it.skipIf(process.platform !== "linux")(`reads the open ${profile ?? "default"} omp transcript when herdr ${includeArgv ? "supplies" : "omits"} argv`, async () => {
    const agentDir = profile === null ? join(home, ".omp/agent") : join(home, ".omp/profiles", profile, "agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...(profile === null ? [] : ["--profile", profile])];
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, name: "omp", ...(includeArgv ? { argv } : {}) }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        forgetTranscriptState();
        const answer = await paneConversation(pane.pane_id);
        expect(answer.source).toBe("omp-transcript");
        expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
          { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
        ]);
      }
    } finally { child.kill(); await child.exited; }
  });

  it.skipIf(process.platform !== "linux")("does not trust the omp name when its argv is inaccessible or belongs to another executable", async () => {
    for (const pid of [2147483647, process.pid]) {
      processes = [{ pid, name: "omp" }];
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    }
  });

  it.skipIf(process.platform !== "linux")("on WSL a failed probe with supplied argv never falls back to a synchronous environment read", async () => {
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(true);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(null);
    restores.push(() => wsl.mockRestore());
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    restores.push(() => probe.mockRestore(), () => environ.mockRestore());
    processes = [{ pid: process.pid, argv: ["omp"] }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    expect(probe).toHaveBeenCalledWith(process.pid, false);
    expect(environ).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("a native Linux pane whose argv herdr supplies keeps the direct read and spawns no helper", async () => {
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(false);
    const probe = spyOn(ompProbe, "ompProcessMemory");
    restores.push(() => wsl.mockRestore(), () => probe.mockRestore());
    processes = [{ pid: process.pid, argv: ["omp"] }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("a successful probe's environment finds the tmux breadcrumb with no synchronous environ read", async () => {
    const agentDir = join(home, ".omp/agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    mkdirSync(join(agentDir, "terminal-sessions"));
    writeFileSync(join(agentDir, "terminal-sessions", "tmux-%4242"), `${pane.cwd}\n${path}\n`);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue({ argv: ["omp"], environ: ["TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%4242"] });
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    const read = fs.readFileSync;
    const files = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith("/environ")) throw new Error(`unsafe synchronous read of ${String(file)}`);
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    restores.push(() => probe.mockRestore(), () => environ.mockRestore(), () => files.mockRestore());
    processes = [{ pid: process.pid, name: "omp" }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
    expect(probe).toHaveBeenCalledWith(process.pid, true);
    expect(environ).not.toHaveBeenCalled();
    expect(files.mock.calls.some(([file]) => String(file).endsWith("/environ"))).toBe(false);
  });
});
