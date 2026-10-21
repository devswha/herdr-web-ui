import { describe, expect, it } from "bun:test";
import { parseElapsed, processStartedAt, processStartLowerBound } from "./process-start.ts";

describe("process start time", () => {
  it("reads every form of ps's elapsed time", () => {
    expect(parseElapsed("   00:07\n")).toBe(7);
    expect(parseElapsed("12:34")).toBe(12 * 60 + 34);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseElapsed("")).toBeNull();
  });

  it("tells when a running process started, to the second", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const started = processStartedAt(child.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - Date.now())).toBeLessThan(2500);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("bounds a process's start from below, closely enough to take in a thread made as it starts", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const lower = processStartLowerBound(child.pid);
      expect(lower).not.toBeNull();
      // never after the process started (it started by the time spawn returned) ...
      expect(lower!).toBeLessThanOrEqual(spawned);
      // ... and close: a tick on Linux, the second `ps` counts on macOS and the one it may round away
      expect(lower!).toBeGreaterThanOrEqual(before - (process.platform === "linux" ? 30 : 2100));
      expect(processStartLowerBound(2147483647)).toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("reads a Linux start to the tick, never before the process started", async () => {
    // /proc/stat's btime is whole seconds: a start read from it could be up to a second early,
    // before a thread the process made as it started, and below the lower bound
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const started = processStartedAt(child.pid)!;
      expect(started).toBeGreaterThanOrEqual(before - 20);
      expect(started).toBeLessThanOrEqual(spawned + 20);
      // the bound is a tick below the start: a thread made as the process starts is above it
      expect(processStartLowerBound(child.pid)!).toBeLessThanOrEqual(started);
    } finally { child.kill(); }
  });
});
