/**
 * Agents herdr's agent.start cannot launch (`herdr agent start --kind` lists its
 * kinds; omo and gjc are not among them). The pane's shell runs the command
 * instead, and the pane's process tree, not the prompt, says when it is up.
 *
 * A Windows pane differs in three ways, each live-verified on a Windows PC (herdr 0.9.3):
 * - its shell is PowerShell or cmd: a quoted path alone is a string there, not a call;
 * - a newline in sent text is a line break in PowerShell's editor (it waits at `>>`): the
 *   command is run by the Enter key;
 * - process_info names only the shell, so the shell's children say whether the agent runs.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { herdrRpc } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { isOmoProcess, omoProcessIdentity } from "./omo.ts";
import { psQuote } from "./powershell.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";

/** kind -> the foreground-process test that proves the agent is running in the pane. */
export const SHELL_AGENTS: Record<string, (argv: readonly string[]) => boolean> = {
  omo: isOmoProcess,
  gjc: isGjcProcess,
};
/** The shell-started agents known to start on Windows; the others are not offered there. */
const WINDOWS_SHELL_AGENTS = new Set(["omo", "gjc"]);

export function isShellAgentKind(kind: string): boolean { return Object.hasOwn(SHELL_AGENTS, kind); }

/** Where this server finds `kind` on its own PATH; the pane's shell is herdr's child and may carry another PATH. */
export function shellAgentExecutable(kind: string, platform: string = process.platform, path: string = process.env["PATH"] ?? ""): string | null {
  if (platform === "win32" && !WINDOWS_SHELL_AGENTS.has(kind)) return null;
  return Bun.which(kind, { PATH: path });
}

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
};

const LOGIN_PATH_START = "__OVIS_LOGIN_PATH__";
const LOGIN_PATH_END = "__OVIS_LOGIN_PATH_END__";
/** The fixed text the login shell runs: no request's kind or argument is ever part of it. printenv prints PATH joined by `:` in fish too. */
const LOGIN_PATH_SCRIPT = `printf '\\n%s\\n' ${LOGIN_PATH_START}; printenv PATH; printf '%s\\n' ${LOGIN_PATH_END}`;

/** The user's login shell as an absolute executable: $SHELL, else the account's; null when neither is one. */
export function loginShell(env: Record<string, string | undefined> = process.env): string | null {
  let account: string | null = null;
  try { account = userInfo().shell; } catch { /* no passwd entry */ }
  for (const shell of [env["SHELL"], account]) if (shell && isAbsolute(shell) && isExecutableFile(shell)) return shell;
  return null;
}

/** The PATH between the markers of the probe's own output; the profile's chatter around them is ignored. */
export function parseLoginPath(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const start = lines.lastIndexOf(LOGIN_PATH_START);
  if (start === -1 || lines[start + 2] !== LOGIN_PATH_END) return null;
  const path = lines[start + 1]!.trim();
  return path === "" ? null : path;
}

export interface LoginPathProbe {
  /** the login shell's PATH, or null when the shell failed, outran its time or said too much */
  (signal: AbortSignal): Promise<string | null>;
}

/**
 * Runs `shell -l -c` once with the fixed script and reads the PATH its profile sets. The shell runs
 * in a process group of its own, so a profile that leaves a child behind is killed with it; at
 * `timeoutMs`, past `maxBytes` of output (stdout and stderr together) or on `signal` the group is
 * killed and the shell reaped before this answers null.
 */
export function loginPathProbe(options: { shell: string; env?: Record<string, string | undefined>; timeoutMs?: number; maxBytes?: number }): LoginPathProbe {
  const { shell, env = process.env, timeoutMs = 2000, maxBytes = 64 * 1024 } = options;
  return (signal) => new Promise((resolve) => {
    if (signal.aborted) { resolve(null); return; }
    const child = spawn(shell, ["-l", "-c", LOGIN_PATH_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const kill = (): void => {
      failed = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(kill, timeoutMs);
    signal.addEventListener("abort", kill, { once: true });
    const done = (answer: string | null): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve(answer);
    };
    // both streams share one budget; only stdout carries the PATH
    const count = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes > maxBytes && !failed) kill();
      return !failed;
    };
    child.stdout!.on("data", (chunk: Buffer) => { if (count(chunk)) chunks.push(chunk); });
    child.stderr!.on("data", count);
    // a shell that cannot be run never exits: its error is the answer
    child.on("error", () => done(null));
    // exit, not close: a grandchild that kept the pipe open is gone with the group, and the shell is reaped here
    child.on("exit", (code) => {
      // whatever the shell left in its group goes with it
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* the group is gone */ }
      done(failed || code !== 0 ? null : parseLoginPath(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

/**
 * Where the shell-started agents are, for both the offer (`/api/agents`) and the start: this
 * server's own PATH first, then, on Unix, the PATH its user's login shell sets, for a server run
 * as a service with a bare PATH. One login shell is run for every kind missing from the service
 * PATH at once, when the server starts and then each `refreshMs` from its own timer, never per
 * request; its hits and misses are kept until the next run. Only the fixed names of SHELL_AGENTS
 * are looked up, and only absolute executable files are kept.
 */
export class ShellAgentLocator {
  readonly #platform: string;
  readonly #servicePath: () => string;
  readonly #probe: LoginPathProbe | null;
  readonly #refreshMs: number;
  readonly #schedule: (refresh: () => void, ms: number) => () => void;
  #found = new Map<string, string>();
  #running: Promise<void> | null = null;
  #abort = new AbortController();
  #cancelTimer: (() => void) | null = null;
  #stopped = false;

  constructor(options: {
    platform?: string;
    /** this server's PATH, read at each lookup */
    servicePath?: () => string;
    /** reads the login shell's PATH; null: this server's PATH alone (tests, and a server with no login shell) */
    probe?: LoginPathProbe | null;
    refreshMs?: number;
    /** runs `refresh` every `ms` and answers its cancel; tests run it by hand */
    schedule?: (refresh: () => void, ms: number) => () => void;
  } = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#servicePath = options.servicePath ?? (() => process.env["PATH"] ?? "");
    // Windows keeps its own PATH and allowlist: no Unix login shell is asked there
    const shell = this.#platform === "win32" || options.probe !== undefined ? null : loginShell();
    this.#probe = this.#platform === "win32" ? null : options.probe !== undefined ? options.probe : shell === null ? null : loginPathProbe({ shell });
    this.#refreshMs = options.refreshMs ?? 60_000;
    this.#schedule = options.schedule ?? ((refresh, ms) => {
      const timer = setInterval(refresh, ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  }

  /** Reads the login PATH now and then every refreshMs; does nothing without a probe. */
  start(): void {
    if (this.#probe === null || this.#stopped || this.#cancelTimer !== null) return;
    void this.refresh();
    this.#cancelTimer = this.#schedule(() => void this.refresh(), this.#refreshMs);
  }

  /** One login-shell run for the kinds this server's PATH misses; a run already going is shared. */
  refresh(): Promise<void> {
    if (this.#probe === null || this.#stopped) return Promise.resolve();
    this.#running ??= this.#lookup(this.#probe).finally(() => { this.#running = null; });
    return this.#running;
  }

  async #lookup(probe: LoginPathProbe): Promise<void> {
    const missing = Object.keys(SHELL_AGENTS).filter((kind) => shellAgentExecutable(kind, this.#platform, this.#servicePath()) === null);
    const found = new Map<string, string>();
    const path = missing.length === 0 ? null : await probe(this.#abort.signal).catch(() => null);
    if (path !== null) {
      for (const kind of missing) {
        const executable = Bun.which(kind, { PATH: path });
        if (executable !== null && isAbsolute(executable) && isExecutableFile(executable)) found.set(kind, executable);
      }
    }
    // a failed run proves nothing is there: it answers as a miss until the next one
    if (!this.#stopped) this.#found = found;
  }

  /**
   * The absolute executable `kind` is started by, or null. A lookup during the first run or a
   * refresh waits for it; a path the last run found that is no longer an executable is not
   * replaced by anything else until the next run.
   */
  async executable(kind: string): Promise<string | null> {
    if (!isShellAgentKind(kind)) return null;
    const own = shellAgentExecutable(kind, this.#platform, this.#servicePath());
    if (own !== null || this.#probe === null) return own;
    if (this.#running !== null) await this.#running;
    const found = this.#found.get(kind);
    return found !== undefined && isExecutableFile(found) ? found : null;
  }

  /** Stops the timer and kills a login shell still running; later lookups use this server's PATH and the last run's answer. */
  stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#abort.abort();
    return this.#running ?? Promise.resolve();
  }
}

/** This server's PATH alone: what a caller that names no locator gets. */
const servicePathOnly = new ShellAgentLocator({ probe: null });

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
/** cmd.exe has no escape for a quote inside quotes, and expands %NAME%. */
function cmdQuote(word: string): string {
  if (/["%\r\n]/.test(word)) throw new Error("this argument cannot be typed into cmd.exe");
  // a backslash right before the closing quote would escape it for the program's own parser
  return `"${word.replace(/\\+$/, (run) => run + run)}"`;
}

export type PaneShell = "posix" | "powershell" | "cmd";
/** Which shell a pane runs, from the program herdr reports in front of it. */
export function paneShell(argv0: string): PaneShell {
  const name = argv0.split(/[\\/]/).pop()!.toLowerCase();
  if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd.exe") return "cmd";
  return "posix";
}

/** The line that runs `executable` with `args` in that shell. */
export function shellCommandLine(shell: PaneShell, executable: string, args: readonly string[]): string {
  if (shell === "powershell") return ["&", psQuote(executable), ...args.map(psQuote)].join(" ");
  if (shell === "cmd") return [executable, ...args].map(cmdQuote).join(" ");
  return [executable, ...args].map(quote).join(" ");
}

interface ProcessInfo { process_info?: { shell_pid?: number; foreground_processes?: { pid: number; argv?: string[]; cwd?: string }[] } }
const processInfo = (paneId: string) => herdrRpc<ProcessInfo>("pane.process_info", { pane_id: paneId }).catch(() => null);

/**
 * Types the agent's absolute path and args into the pane's shell and resolves once
 * `kind` is its foreground process, with that process's pid; null on Windows, where it is
 * found among the shell's descendants and not in front. The path comes from the same
 * `locator` `/api/agents` asked, so the offer and the start agree whatever the pane shell's
 * PATH says.
 */
export async function startShellAgent(kind: string, paneId: string, args: string[] = [], options: { command?: string; timeoutMs?: number; locator?: ShellAgentLocator } = {}): Promise<number | null> {
  const isProcess = SHELL_AGENTS[kind];
  if (!isProcess) throw new Error(`${kind} is not a shell-started agent`);
  const windows = process.platform === "win32";
  if (options.command !== undefined || !windows) {
    let command = options.command;
    if (command === undefined) {
      const executable = await (options.locator ?? servicePathOnly).executable(kind);
      if (!executable) throw new Error(`${kind} is not on this server's PATH or its login shell's`);
      command = shellCommandLine("posix", executable, []);
    }
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${[command, ...args.map(quote)].join(" ")}\n` });
  } else {
    const executable = await (options.locator ?? servicePathOnly).executable(kind);
    if (!executable) throw new Error(`${kind} is not on this server's PATH`);
    const shell = paneShell((await processInfo(paneId))?.process_info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
    await herdrRpc("pane.send_text", { pane_id: paneId, text: shellCommandLine(shell, executable, args) });
    await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const info = await processInfo(paneId);
    const started = info?.process_info?.foreground_processes?.find((entry) => kind === "omo" ? omoProcessIdentity(entry, "", process.env["HOME"] ?? "") !== null : isProcess(entry.argv ?? []));
    if (started) return started.pid;
    const shellPid = info?.process_info?.shell_pid;
    // the table query never outlasts what is left of the start's own time
    if (windows && typeof shellPid === "number" && descendantArgv(await windowsProcessTable(Math.max(500, Math.min(10_000, deadline - Date.now()))), shellPid).some(isProcess)) return null;
    await Bun.sleep(250);
  }
  throw new Error(`${kind} did not start in the pane`);
}
