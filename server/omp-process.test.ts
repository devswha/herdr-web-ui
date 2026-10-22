import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpCwdProbe, createOmpProcessProbe, lsofCwd, ompCwdCommand, processStartTicks } from "./omp-process.ts";

it.skipIf(process.platform !== "linux")("reads a live process's arguments and only the environment omp lookups need", async () => {
  const env = { PATH: process.env["PATH"] ?? "", OMP_PROFILE: "personal", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", SECRET_TOKEN: "do-not-pass" };
  const target = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const read = createOmpProcessProbe();
    const result = await read(target.pid, true);
    expect(result?.argv.length).toBeGreaterThan(0);
    expect([...result?.environ ?? []].sort()).toEqual(["OMP_PROFILE=personal", "TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%3"]);
    expect((await createOmpProcessProbe()(target.pid, false))?.argv).toEqual([]);
    expect(await read(2147483647, true)).toBeNull();
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps a process's empty arguments where they stand", async () => {
  const argv = [process.execPath, "-e", "setInterval(() => {}, 1000)", "--cwd", "", "/B", ""];
  const target = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    expect((await createOmpProcessProbe()(target.pid, true))?.argv).toEqual(argv);
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps a successful read per process start, never a failed one", async () => {
  const start = processStartTicks(process.pid)!;
  let starts = 0, fail = true, ticks = start;
  const read = createOmpProcessProbe({
    startTicks: () => ticks,
    command: () => { starts++; return [process.execPath, "-e", fail ? "process.exit(1)" : `console.log(JSON.stringify({start:${JSON.stringify(start)},argv:["omp"],environ:[]}))`]; },
  });
  expect(await read(process.pid, true)).toBeNull();
  fail = false;
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, false))?.argv).toEqual(["omp"]);
  expect(starts).toBe(2);
  // the pid now names a process that started at another time: the helper's answer is not its
  ticks = `${start}1`;
  expect(await read(process.pid, true)).toBeNull();
  expect(starts).toBe(3);
});

it.skipIf(process.platform !== "linux")("a stalled memory read has a deadline and leaves the event loop responsive", async () => {
  const read = createOmpProcessProbe({ timeoutMs: 100, command: () => [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
  const result = read(process.pid, true);
  let settled = false;
  void result.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("deadline missed"), 1000))])).toBeNull();
});

it.skipIf(process.platform !== "linux")("deduplicates reads and bounds outstanding helpers when polling repeats", async () => {
  let starts = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const read = createOmpProcessProbe({ timeoutMs: 100, maxProcesses: 1, startTicks: () => "1", command: () => { starts++; return [process.execPath, "-e", "setInterval(() => {}, 1000)"]; } });
    const first = read(1, true);
    expect(read(1, true)).toBe(first);
    expect(await read(2, true)).toBeNull();
    expect(await read(3, true)).toBeNull();
    expect(starts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await first).toBeNull();
  } finally { warn.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("rejects malformed or excessive helper output and invalid process IDs", async () => {
  for (const script of ["console.log('not JSON')", "console.log(JSON.stringify({argv:[42],environ:[]}))", "console.log(JSON.stringify({start:'0',argv:[],environ:[]}))", "console.log('x'.repeat(1024*1024+1))", "process.exit(1)"]) {
    const read = createOmpProcessProbe({ command: () => [process.execPath, "-e", script] });
    expect(await read(process.pid, true)).toBeNull();
  }
  let starts = 0;
  const read = createOmpProcessProbe({ command: () => { starts++; return []; } });
  for (const pid of [-1, 0, 1.5, Number.NaN]) expect(await read(pid, true)).toBeNull();
  expect(starts).toBe(0);
});

it.skipIf(process.platform !== "linux")("reads a live process's own directory afresh on every lookup", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omp-cwd-probe-")));
  const target = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    let starts = 0;
    const read = createOmpCwdProbe({ command: (pid) => { starts++; return ompCwdCommand(pid, "linux"); } });
    expect(await read(target.pid)).toBe(dir);
    // never cached: a process may change directory between lookups
    expect(await read(target.pid)).toBe(dir);
    expect(starts).toBe(2);
    // concurrent lookups of one process start share one read
    const first = read(target.pid);
    expect(read(target.pid)).toBe(first);
    expect(await first).toBe(dir);
    expect(starts).toBe(3);
    expect(await read(2147483647)).toBeNull();
  } finally { target.kill(); await target.exited; rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux" || process.getuid?.() === 0)("a directory procfs denies is unreadable", async () => {
  // init's directory is closed to other users
  expect(await createOmpCwdProbe()(1)).toBeNull();
});

it("a reused pid or a deleted directory gives no directory", async () => {
  const answer = (start: string, cwd: string) => [process.execPath, "-e", `console.log(JSON.stringify({start:${JSON.stringify(start)},cwd:${JSON.stringify(cwd)}}))`];
  // the helper read a process that started at another time
  expect(await createOmpCwdProbe({ platform: "linux", startTicks: () => "5", command: () => answer("6", "/a") })(42)).toBeNull();
  // the pid named another process by the time the helper answered
  let ticks = "5";
  const reused = createOmpCwdProbe({ platform: "linux", startTicks: () => ticks, command: () => { ticks = "7"; return answer("5", "/a"); } });
  expect(await reused(42)).toBeNull();
  expect(await createOmpCwdProbe({ platform: "linux", startTicks: () => "5", command: () => answer("5", "/a (deleted)") })(42)).toBeNull();
  expect(await createOmpCwdProbe({ platform: "linux", startTicks: () => "5", command: () => answer("5", "relative") })(42)).toBeNull();
  expect(await createOmpCwdProbe({ platform: "linux", startTicks: () => "5", command: () => answer("5", "/a b/$(c)") })(42)).toBe("/a b/$(c)");
  // a process already gone spawns no helper
  let starts = 0;
  expect(await createOmpCwdProbe({ platform: "linux", startTicks: () => null, command: () => { starts++; return answer("5", "/a"); } })(42)).toBeNull();
  expect(starts).toBe(0);
});

it("takes macOS's directory only from one lsof answer for that process", async () => {
  expect(lsofCwd("p42\nfcwd\nn/Users/u/project dir\n", 42)).toBe("/Users/u/project dir");
  expect(lsofCwd("", 42)).toBeNull();
  expect(lsofCwd("p42\nfcwd\n", 42)).toBeNull();
  expect(lsofCwd("p42\nfcwd\nn/a\nfcwd\nn/b\n", 42)).toBeNull();
  expect(lsofCwd("p43\nfcwd\nn/a\n", 42)).toBeNull();
  expect(lsofCwd("p42\nfcwd\nn/a\np43\nfcwd\nn/b\n", 42)).toBeNull();
  expect(lsofCwd("p42\nfcwd\nnrelative\n", 42)).toBeNull();
  const answer = (value: unknown) => [process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify(value))})`];
  const darwin = (value: unknown) => createOmpCwdProbe({ platform: "darwin", command: () => answer(value) })(42);
  expect(await darwin({ start: "Tue Oct 21 10:00:00 2026", lsof: "p42\nfcwd\nn/Users/u/a\n" })).toBe("/Users/u/a");
  // no start time: the helper saw the process change or vanish while lsof ran
  expect(await darwin({ start: "", lsof: "p42\nfcwd\nn/Users/u/a\n" })).toBeNull();
  expect(await darwin({ start: "Tue Oct 21 10:00:00 2026", lsof: "p42\nfcwd\n" })).toBeNull();
  expect(await darwin({ start: "Tue Oct 21 10:00:00 2026", lsof: "p42\nfcwd\nn/a\nfcwd\nn/b\n" })).toBeNull();
  expect(ompCwdCommand(42, "darwin").join(" ")).toContain("lsof");
});

it("reads no process directory on Windows", async () => {
  let starts = 0;
  const read = createOmpCwdProbe({ platform: "win32", command: () => { starts++; return [process.execPath, "-e", "console.log('{}')"]; } });
  expect(await read(42)).toBeNull();
  expect(starts).toBe(0);
});

it.skipIf(process.platform !== "linux")("directory reads keep the deadline, output bound and helper slots of memory reads", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const stall = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    // one slot, taken by a stuck memory read: the directory read spawns nothing
    const slots = { live: 0, warned: false };
    let starts = 0;
    const memory = createOmpProcessProbe({ timeoutMs: 100, maxProcesses: 1, slots, startTicks: () => "1", command: () => stall });
    const cwd = createOmpCwdProbe({ timeoutMs: 100, maxProcesses: 1, slots, startTicks: () => "1", command: () => { starts++; return stall; } });
    const stuck = memory(1, true);
    expect(await cwd(2)).toBeNull();
    expect(starts).toBe(0);
    expect(await stuck).toBeNull();
    // a stalled directory read misses its deadline
    const deadline = createOmpCwdProbe({ timeoutMs: 100, startTicks: () => "1", command: () => stall });
    expect(await Promise.race([deadline(3), new Promise((resolve) => setTimeout(() => resolve("deadline missed"), 1000))])).toBeNull();
    const excessive = createOmpCwdProbe({ startTicks: () => "1", command: () => [process.execPath, "-e", "console.log('x'.repeat(1024*1024+1))"] });
    expect(await excessive(4)).toBeNull();
  } finally { warn.mockRestore(); }
});
