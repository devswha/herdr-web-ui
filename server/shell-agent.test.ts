import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as client from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { loginPathProbe, paneShell, parseLoginPath, shellAgentExecutable, ShellAgentLocator, shellCommandLine, startShellAgent, type LoginPathProbe } from "./shell-agent.ts";
import { descendantArgv, descendantProcesses, parseProcessTable, windowsArgv, windowsProcessTable } from "./windows-processes.ts";

it("tells a pane's shell from the program herdr reports in front", () => {
  expect(paneShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
  expect(paneShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
  expect(paneShell("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  expect(paneShell("/bin/zsh")).toBe("posix");
});

it("writes the line each shell runs as a command, not as a string", () => {
  const exe = "C:\\Users\\o'brien\\AppData\\Local\\gjc\\gjc.exe";
  expect(shellCommandLine("powershell", exe, ["--resume", "a b"])).toBe("& 'C:\\Users\\o''brien\\AppData\\Local\\gjc\\gjc.exe' '--resume' 'a b'");
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["a b"])).toBe('"C:\\gjc\\gjc.exe" "a b"');
  expect(shellCommandLine("posix", "/usr/local/bin/gjc", ["it's"])).toBe("'/usr/local/bin/gjc' 'it'\\''s'");
  // a trailing backslash must not escape the closing quote for the program that parses it
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["C:\\work\\", "--resume"])).toBe('"C:\\gjc\\gjc.exe" "C:\\work\\\\" "--resume"');
  // cmd cannot carry these inside quotes
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["%PATH%"])).toThrow();
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ['say "hi"'])).toThrow();
});

it("recognizes gjc as Windows reports it", () => {
  expect(isGjcProcess(["C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"])).toBe(true);
  expect(isGjcProcess(["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\gjc\\dist\\gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit"])).toBe(false);
  expect(isGjcProcess(["C:\\tools\\gjc-helper.exe"])).toBe(false);
});

it("finds what runs under a pane's shell in the process table", () => {
  // the table as PowerShell prints it; rows from a Windows PC with gjc running in a pane
  const table = parseProcessTable(JSON.stringify([
    { ProcessId: 41948, ParentProcessId: 26540, ExecutablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", CommandLine: "powershell.exe -NoExit" },
    { ProcessId: 12156, ParentProcessId: 41948, ExecutablePath: "C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe", CommandLine: '"C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"' },
    { ProcessId: 700, ParentProcessId: 12156, ExecutablePath: null, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\tool.js" --flag' },
    { ProcessId: 9, ParentProcessId: 4, ExecutablePath: "C:\\other\\gjc.exe", CommandLine: "gjc.exe" },
    { ProcessId: "bad" },
  ]));
  const under = descendantArgv(table, 41948);
  expect(under).toEqual([
    ["C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"],
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\x y\\tool.js", "--flag"],
  ]);
  expect(under.some(isGjcProcess)).toBe(true);
  // the same walk, with each process's number
  expect(descendantProcesses(table, 41948).map((entry) => entry.pid)).toEqual([12156, 700]);
  // another pane's shell has no gjc under it, though one runs elsewhere on the PC
  expect(descendantArgv(table, 26540).length).toBe(3);
  expect(descendantArgv(table, 4242)).toEqual([]);
  expect(parseProcessTable("not json")).toEqual([]);
  // the process's start, as the table script reads it (ms since 1970), comes along when present
  expect(parseProcessTable(JSON.stringify({ ProcessId: 2, ParentProcessId: 1, ExecutablePath: null, CommandLine: "x", Started: 1790886000123 }))).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x", started: 1790886000123 }]);
  expect(windowsArgv('"C:\\a b\\x.exe" one "two three"')).toEqual(["C:\\a b\\x.exe", "one", "two three"]);
});

it("gives up on a process-table query that stalls, and kills it", async () => {
  const started = Date.now();
  expect(await windowsProcessTable(200, ["sleep", "30"])).toEqual([]);
  expect(Date.now() - started).toBeLessThan(5000);
  // a query that answers is read
  expect(await windowsProcessTable(5000, ["printf", '[{"ProcessId":2,"ParentProcessId":1,"ExecutablePath":null,"CommandLine":"x"}]'])).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x" }]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * A Unix HOME of its own, a service PATH without gjc, and a login PATH with it: `shell` is a
 * test-owned stand-in for the user's login shell that sets that PATH only when run with `-l`,
 * after `profile` (its stand-in for a profile's own output and children). No dotfile is read.
 */
function fixture(profile = "echo 'Welcome to the fixture shell'") {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-shell-agent-path-"));
  roots.push(root);
  const home = join(root, "home"), serviceBin = join(root, "service bin"), loginBin = join(root, "login bin");
  for (const dir of [home, serviceBin, loginBin]) mkdirSync(dir);
  const gjc = join(loginBin, "gjc");
  writeFileSync(gjc, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const shell = join(root, "login-shell");
  writeFileSync(shell, [
    "#!/bin/sh",
    `if [ "$1" = "-l" ]; then PATH='${loginBin}:/usr/bin:/bin'; export PATH; shift; ${profile}; fi`,
    '[ "$1" = "-c" ] && exec /bin/sh -c "$2"',
    "exit 64",
    "",
  ].join("\n"), { mode: 0o755 });
  const env = { HOME: home, PATH: serviceBin };
  const servicePath = () => `${serviceBin}:/nonexistent`;
  return { root, home, serviceBin, loginBin, gjc, shell, env, servicePath };
}

/** A probe that counts its runs. */
function counted(probe: LoginPathProbe): { probe: LoginPathProbe; runs: () => number } {
  let runs = 0;
  return { probe: (signal) => { runs += 1; return probe(signal); }, runs: () => runs };
}

/** Whether `pid` still runs; a zombie waiting for its new parent to reap it does not. */
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch { return false; }
  const state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
  return state !== "" && !state.startsWith("Z");
}

/** Resolves once `file` exists with content; bounded, so a probe that never got there fails the test. */
function written(file: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      if (!existsSync(file)) return false;
      const text = readFileSync(file, "utf8").trim();
      if (text === "") return false;
      watcher.close();
      clearTimeout(timer);
      resolve(text);
      return true;
    };
    const watcher = watch(join(file, ".."), () => { check(); });
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`${file} was not written`)); }, timeoutMs);
    check();
  });
}

it("reads the login PATH between its markers, whatever the profile prints around them", () => {
  expect(parseLoginPath("motd\n__HERDR_WEB_LOGIN_PATH__\n/a:/b\n__HERDR_WEB_LOGIN_PATH_END__\nbye\n")).toBe("/a:/b");
  expect(parseLoginPath("/a:/b\n")).toBeNull();
  expect(parseLoginPath("__HERDR_WEB_LOGIN_PATH__\n/a\nno end\n")).toBeNull();
  expect(parseLoginPath("__HERDR_WEB_LOGIN_PATH__\n\n__HERDR_WEB_LOGIN_PATH_END__\n")).toBeNull();
});

it("service miss resolves the same executable for offer and start", async () => {
  const f = fixture();
  // today's lookup: the service PATH misses gjc
  expect(shellAgentExecutable("gjc", "linux", f.servicePath())).toBeNull();
  const { probe, runs } = counted(loginPathProbe({ shell: f.shell, env: f.env }));
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, schedule: () => () => undefined });
  // without the login fallback the start misses it too
  const serviceOnly = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe: null });
  await expect(startShellAgent("gjc", "w1-1", [], { locator: serviceOnly })).rejects.toThrow("not on this server's PATH");
  locator.start();
  // the offer, read before the first run is over, waits for it
  expect(await locator.executable("gjc")).toBe(f.gjc);
  expect(await locator.executable("omo")).toBeNull();
  expect(await locator.executable("claude")).toBeNull();
  const sent: string[] = [];
  const rpc = spyOn(client, "herdrRpc").mockImplementation((async (method: string, params: { text?: string }) => {
    if (method === "pane.send_text") { sent.push(params.text ?? ""); return {}; }
    if (method === "pane.process_info") return { process_info: { shell_pid: 7, foreground_processes: sent.length === 0 ? [] : [{ pid: 4242, argv: [f.gjc, "it's"] }] } };
    throw new Error(`unexpected ${method}`);
  }) as typeof client.herdrRpc);
  try {
    expect(await startShellAgent("gjc", "w1-1", ["it's"], { locator, timeoutMs: 5000 })).toBe(4242);
  } finally {
    rpc.mockRestore();
  }
  // the start typed the absolute path the offer found, quoted as every shell-started command is
  expect(sent).toEqual([`${shellCommandLine("posix", f.gjc, ["it's"])}\n`]);
  // one login shell for the warm-up; the reads and the start ran none
  expect(runs()).toBe(1);
});

it("concurrent callers share one probe", async () => {
  const f = fixture();
  let answer!: (path: string | null) => void;
  const { probe, runs } = counted(() => new Promise((resolve) => { answer = resolve; }));
  let tick: () => void = () => undefined;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, schedule: (refresh) => { tick = refresh; return () => undefined; } });
  locator.start();
  const reads = Promise.all([...Array.from({ length: 8 }, () => locator.executable("gjc")), locator.refresh().then(() => null), locator.executable("omo")]);
  expect(runs()).toBe(1);
  answer(`${f.loginBin}:/usr/bin`);
  expect(await reads).toEqual([...Array.from({ length: 8 }, () => f.gjc), null, null]);
  // hits and misses are kept: later reads run nothing
  expect(await locator.executable("gjc")).toBe(f.gjc);
  expect(await locator.executable("omo")).toBeNull();
  expect(runs()).toBe(1);

  // a removed executable is not replaced by anything, even before the next run
  unlinkSync(f.gjc);
  writeFileSync(join(f.root, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBeNull();
  expect(runs()).toBe(1);
  // the timer's next run sees it gone, and then sees it again once it is back
  tick();
  answer(`${f.loginBin}:/usr/bin`);
  expect(await locator.executable("gjc")).toBeNull();
  writeFileSync(f.gjc, "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBeNull();
  tick();
  answer(`${f.loginBin}:/usr/bin`);
  expect(await locator.executable("gjc")).toBe(f.gjc);
  // a file that is not executable, a relative PATH entry and a failed run are misses
  chmodSync(f.gjc, 0o644);
  tick();
  answer(`${f.loginBin}:relative`);
  expect(await locator.executable("gjc")).toBeNull();
  chmodSync(f.gjc, 0o755);
  tick();
  answer(null);
  expect(await locator.executable("gjc")).toBeNull();
  expect(runs()).toBe(5);
  // what the service PATH has needs no login shell at all
  writeFileSync(join(f.serviceBin, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(f.serviceBin, "omo"), "#!/bin/sh\n", { mode: 0o755 });
  tick();
  expect(await locator.executable("gjc")).toBe(join(f.serviceBin, "gjc"));
  expect(runs()).toBe(5);
});

it("hung or oversized login probe is killed and reaped", async () => {
  // a profile that hangs, with a child of its own
  const hung = fixture(`sleep 30 & echo $! > "${"$"}HOME/child.tmp"; mv "${"$"}HOME/child.tmp" "${"$"}HOME/child.pid"; echo $$ > "${"$"}HOME/shell.tmp"; mv "${"$"}HOME/shell.tmp" "${"$"}HOME/shell.pid"; wait`);
  const started = Date.now();
  expect(await loginPathProbe({ shell: hung.shell, env: hung.env, timeoutMs: 300 })(new AbortController().signal)).toBeNull();
  expect(Date.now() - started).toBeLessThan(5000);
  for (const pid of [await written(join(hung.home, "shell.pid")), await written(join(hung.home, "child.pid"))]) expect(await running(Number(pid))).toBe(false);

  // a profile that prints more than 64 KiB, and then a PATH
  const noisy = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 200000 /dev/zero | tr '\\\\0' x`);
  expect(await loginPathProbe({ shell: noisy.shell, env: noisy.env, timeoutMs: 5000 })(new AbortController().signal)).toBeNull();
  expect(await running(Number(await written(join(noisy.home, "shell.pid"))))).toBe(false);
  // stderr counts against the same limit: a flood on stderr alone, and one split across both streams
  const loud = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 200000 /dev/zero | tr '\\\\0' x >&2`);
  expect(await loginPathProbe({ shell: loud.shell, env: loud.env, timeoutMs: 5000 })(new AbortController().signal)).toBeNull();
  expect(await running(Number(await written(join(loud.home, "shell.pid"))))).toBe(false);
  const mixed = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 40000 /dev/zero | tr '\\\\0' x; head -c 40000 /dev/zero | tr '\\\\0' y >&2`);
  expect(await loginPathProbe({ shell: mixed.shell, env: mixed.env, timeoutMs: 5000 })(new AbortController().signal)).toBeNull();
  expect(await running(Number(await written(join(mixed.home, "shell.pid"))))).toBe(false);

  // a chatty profile under the limit is fine; a shell that is not there or fails says nothing
  const chatty = fixture("echo 'PATH=/not/this'; echo __HERDR_WEB_LOGIN_PATH_END__");
  expect(await loginPathProbe({ shell: chatty.shell, env: chatty.env })(new AbortController().signal)).toBe(`${chatty.loginBin}:/usr/bin:/bin`);
  expect(await loginPathProbe({ shell: join(chatty.root, "no-such-shell"), env: chatty.env })(new AbortController().signal)).toBeNull();
  const failing = fixture("exit 3");
  expect(await loginPathProbe({ shell: failing.shell, env: failing.env })(new AbortController().signal)).toBeNull();
  // and a failed run offers nothing
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: hung.servicePath, probe: loginPathProbe({ shell: hung.shell, env: hung.env, timeoutMs: 300 }), schedule: () => () => undefined });
  locator.start();
  expect(await locator.executable("gjc")).toBeNull();
  await locator.stop();
});

it("Windows does not invoke a Unix login shell", async () => {
  const f = fixture();
  const probe = mock<LoginPathProbe>(async () => `${f.loginBin}`);
  let scheduled = 0;
  const locator = new ShellAgentLocator({ platform: "win32", servicePath: f.servicePath, probe, schedule: () => { scheduled += 1; return () => undefined; } });
  locator.start();
  await locator.refresh();
  expect(await locator.executable("gjc")).toBeNull();
  writeFileSync(join(f.serviceBin, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBe(join(f.serviceBin, "gjc"));
  expect(probe).not.toHaveBeenCalled();
  expect(scheduled).toBe(0);
  // nor without a probe given: its own default asks no shell either
  const plain = new ShellAgentLocator({ platform: "win32", servicePath: f.servicePath });
  plain.start();
  expect(await plain.executable("omo")).toBeNull();
});

it("stop cancels refresh without leaking a child", async () => {
  const f = fixture(`echo $$ > "${"$"}HOME/shell.tmp"; mv "${"$"}HOME/shell.tmp" "${"$"}HOME/shell.pid"; exec sleep 30`);
  const { probe, runs } = counted(loginPathProbe({ shell: f.shell, env: f.env, timeoutMs: 30_000 }));
  let cancelled = 0;
  let tick: () => void = () => undefined;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, schedule: (refresh) => { tick = refresh; return () => { cancelled += 1; }; } });
  locator.start();
  const pid = Number(await written(join(f.home, "shell.pid")));
  expect(await running(pid)).toBe(true);
  const started = Date.now();
  await locator.stop();
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await running(pid)).toBe(false);
  expect(cancelled).toBe(1);
  // a stopped locator runs no more shells, from its timer or a read
  tick();
  await locator.refresh();
  expect(await locator.executable("gjc")).toBeNull();
  expect(runs()).toBe(1);
});

it("offers OmO on Windows when its launcher is on PATH", () => {
  const which = spyOn(Bun, "which").mockReturnValue("C:\\tools\\omo.exe");
  try {
    expect(shellAgentExecutable("omo", "win32")).toBe("C:\\tools\\omo.exe");
    expect(which).toHaveBeenCalledWith("omo", { PATH: process.env["PATH"] ?? "" });
    which.mockReturnValue(null);
    expect(shellAgentExecutable("omo", "win32")).toBeNull();
  } finally {
    which.mockRestore();
  }
});
