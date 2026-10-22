/** WSL can block procfs memory reads during agent exit. Keep them outside the bridge. */
import { readFileSync } from "node:fs";

export interface ProcessMemory { argv: string[]; environ: string[] }
const MAX_OUTPUT = 1024 * 1024;
const MAX_CACHED = 64;
/** Only what omp's store and terminal lookups read: the rest of the environment may hold secrets. */
const SCRIPT = `
const fs = require("node:fs"), pid = process.argv[1];
try {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (/^[DZXx]$/.test(fields[0])) process.exit(1);
  // each word ends in a NUL: drop only the empty entry after the last one, since an empty argument counts
  const read = name => {
    const words = fs.readFileSync("/proc/" + pid + "/" + name, "utf8").split("\\0");
    if (words.at(-1) === "") words.pop();
    return words;
  };
  const environ = read("environ").filter(word => /^(?:OMP_PROFILE|TMUX|TMUX_PANE)=/.test(word));
  console.log(JSON.stringify({ start: fields[19], argv: process.argv[2] === "1" ? read("cmdline") : [], environ }));
} catch { process.exit(1); }
`;
/** A process's current directory on Linux, between two reads of its start time. */
const LINUX_CWD_SCRIPT = `
const fs = require("node:fs"), pid = process.argv[1];
try {
  const start = () => {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (/^[DZXx]$/.test(fields[0])) process.exit(1);
    return fields[19];
  };
  const before = start();
  const cwd = fs.readlinkSync("/proc/" + pid + "/cwd");
  if (start() !== before) process.exit(1);
  console.log(JSON.stringify({ start: before, cwd }));
} catch { process.exit(1); }
`;
/** lsof's answer for a process's current directory on macOS, between two reads of its start time. */
const DARWIN_CWD_SCRIPT = `
const { execFileSync } = require("node:child_process"), pid = process.argv[1];
const run = (file, args) => execFileSync(file, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
try {
  const start = () => run("ps", ["-p", pid, "-o", "lstart="]).trim();
  const before = start();
  const lsof = run("lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"]);
  if (!before || start() !== before) process.exit(1);
  console.log(JSON.stringify({ start: before, lsof }));
} catch { process.exit(1); }
`;

/**
 * A process's start time in clock ticks after boot, /proc/<pid>/stat field 22. stat takes no mm
 * lock, so it answers even while cmdline or environ would block. null once the process is gone.
 */
export function processStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return start && /^\d+$/.test(start) ? start : null;
  } catch { return null; }
}

let wsl: boolean | undefined;
/** WSL's kernel names itself in osrelease; read once, it cannot change while we run. */
export function isWsl(): boolean {
  if (wsl === undefined) {
    try { wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8")); } catch { wsl = false; }
  }
  return wsl;
}

/** Helpers not yet exited, answered or not, counted across the probes that share them. */
export interface HelperSlots { live: number; warned: boolean }

/**
 * One helper's standard output, or null when it failed, wrote more than MAX_OUTPUT, missed the
 * deadline or found every slot taken. A timed-out child keeps its slot until it exits.
 */
function runHelper(command: () => string[], slots: HelperSlots, maxProcesses: number, timeoutMs: number): Promise<string | null> {
  if (slots.live >= maxProcesses) {
    if (!slots.warned) {
      slots.warned = true;
      console.warn(`omp: ${maxProcesses} process reads are still stuck in the kernel; omp chat cannot find transcripts until they exit or the server restarts`);
    }
    return Promise.resolve(null);
  }
  let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try { child = Bun.spawn(command(), { stdin: "ignore", stdout: "pipe", stderr: "ignore" }); }
  catch { return Promise.resolve(null); }
  child.unref();
  slots.live++;
  void child.exited.then(() => { slots.live--; }, () => { slots.live--; });
  const reader = child.stdout.getReader();
  return new Promise<string | null>((resolve) => {
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // A kernel-blocked child may not exit promptly even after SIGKILL. Never await it here.
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      void reader.cancel().catch(() => {});
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    void (async () => {
      let output = "", bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_OUTPUT) { finish(null); return; }
          output += decoder.decode(chunk.value, { stream: true });
        }
        finish(output + decoder.decode());
      } catch { finish(null); }
    })();
  });
}

const words = (v: unknown): v is string[] => Array.isArray(v) && v.every((word) => typeof word === "string");

/**
 * Concurrent polls share a probe; timed-out children retain their slot until they exit. A
 * successful answer is kept per pid and start time, so polling one process spawns one helper and
 * a reused pid misses; a failed one is never kept, so the next poll tries again.
 */
export function createOmpProcessProbe({ timeoutMs = 1000, maxProcesses = 4, slots = { live: 0, warned: false }, startTicks = processStartTicks, command = (pid, argv) => [process.execPath, "-e", SCRIPT, String(pid), argv ? "1" : "0"] }: {
  timeoutMs?: number;
  maxProcesses?: number;
  slots?: HelperSlots;
  startTicks?: (pid: number) => string | null;
  command?: (pid: number, argv: boolean) => string[];
} = {}): (pid: number, argv: boolean) => Promise<ProcessMemory | null> {
  /** Answers still being read, shared by concurrent polls of one process. */
  const pending = new Map<string, Promise<ProcessMemory | null>>();
  const cache = new Map<number, { start: string; argv: boolean; memory: ProcessMemory }>();
  return (pid, argv) => {
    if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
    const start = startTicks(pid);
    if (start === null) { cache.delete(pid); return Promise.resolve(null); }
    const cached = cache.get(pid);
    if (cached && cached.start !== start) cache.delete(pid);
    else if (cached && (cached.argv || !argv)) return Promise.resolve(cached.memory);
    const key = `${pid}:${argv}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const answer = runHelper(() => command(pid, argv), slots, maxProcesses, timeoutMs).then((output) => {
      pending.delete(key);
      if (output === null) return null;
      try {
        const value: unknown = JSON.parse(output);
        if (value === null || typeof value !== "object" || !("argv" in value) || !("environ" in value) || !words(value.argv) || !words(value.environ)) return null;
        // a different start time: the pid was reused, and the helper read another process
        if (!("start" in value) || value.start !== start) return null;
        const memory = { argv: value.argv, environ: value.environ };
        if (cache.size >= MAX_CACHED && !cache.has(pid)) cache.delete(cache.keys().next().value!);
        cache.set(pid, { start, argv, memory });
        return memory;
      } catch { return null; }
    });
    pending.set(key, answer);
    return answer;
  };
}

/**
 * The one absolute directory `lsof -a -d cwd -p <pid> -Fn` names for `pid`, or null when it
 * answers for another process, names no directory or more than one.
 */
export function lsofCwd(output: string, pid: number): string | null {
  const lines = output.split("\n").filter(Boolean);
  const processes = lines.filter((line) => line.startsWith("p"));
  const names = lines.filter((line) => line.startsWith("n"));
  if (processes.length !== 1 || processes[0] !== `p${pid}` || names.length !== 1) return null;
  const path = names[0]!.slice(1);
  return path.startsWith("/") ? path : null;
}

/** The helper that reads a process's current directory on `platform`. */
export function ompCwdCommand(pid: number, platform: NodeJS.Platform): string[] {
  return [process.execPath, "-e", platform === "darwin" ? DARWIN_CWD_SCRIPT : LINUX_CWD_SCRIPT, String(pid)];
}

/**
 * A process's current directory, read by a helper under the same deadline, output bound and
 * slots as the memory reads: procfs on Linux, lsof on macOS, nothing elsewhere. Never cached, since
 * a process can change directory at any time: concurrent polls of one process start share a read.
 */
export function createOmpCwdProbe({ timeoutMs = 1000, maxProcesses = 4, slots = { live: 0, warned: false }, platform = process.platform, startTicks = processStartTicks, command = (pid) => ompCwdCommand(pid, platform) }: {
  timeoutMs?: number;
  maxProcesses?: number;
  slots?: HelperSlots;
  platform?: NodeJS.Platform;
  startTicks?: (pid: number) => string | null;
  command?: (pid: number) => string[];
} = {}): (pid: number) => Promise<string | null> {
  const pending = new Map<string, Promise<string | null>>();
  return (pid) => {
    if (platform !== "linux" && platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
    // macOS has no cheap start time here: its helper checks the start itself, before and after lsof
    const start = platform === "linux" ? startTicks(pid) : "";
    if (start === null) return Promise.resolve(null);
    const key = `${pid}:${start}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const answer = runHelper(() => command(pid), slots, maxProcesses, timeoutMs).then((output) => {
      pending.delete(key);
      if (output === null) return null;
      try {
        const value = JSON.parse(output) as { start?: unknown; cwd?: unknown; lsof?: unknown } | null;
        if (typeof value?.start !== "string" || value.start === "") return null;
        if (platform === "darwin") return typeof value.lsof === "string" ? lsofCwd(value.lsof, pid) : null;
        // the pid was reused while it was read, or its directory was deleted
        if (value.start !== start || startTicks(pid) !== start) return null;
        return typeof value.cwd === "string" && value.cwd.startsWith("/") && !value.cwd.endsWith(" (deleted)") ? value.cwd : null;
      } catch { return null; }
    });
    pending.set(key, answer);
    return answer;
  };
}

/** One set of slots for every read of omp processes, so stuck helpers never exceed four together. */
const helpers: HelperSlots = { live: 0, warned: false };
export const ompProcessMemory = createOmpProcessProbe({ slots: helpers });
export const ompProcessCwd = createOmpCwdProbe({ slots: helpers });
