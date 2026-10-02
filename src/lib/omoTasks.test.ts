import { expect, test } from "bun:test";
import type { OmoTask } from "../../shared/protocol.ts";
import { clockOffsetMs, formatElapsed, taskElapsedMs } from "./omoTasks.ts";

const task = (over: Partial<OmoTask>): OmoTask => ({ id: "st_1", title: "t", category: null, model: null, status: "running", started_at: "2026-10-02T05:00:00Z", ended_at: null, turns: null, tool_calls: null, tokens: null, ...over });
const at = Date.parse("2026-10-02T05:04:12Z");

test("a running task counts to now, an ended one to its end", () => {
  expect(taskElapsedMs(task({}), at)).toBe(252_000);
  expect(taskElapsedMs(task({ status: "completed", ended_at: "2026-10-02T05:01:00Z" }), at)).toBe(60_000);
});

test("no start, no end, or an end before the start: unknown", () => {
  expect(taskElapsedMs(task({ started_at: null }), at)).toBeNull();
  expect(taskElapsedMs(task({ status: "lost" }), at)).toBeNull();
  expect(taskElapsedMs(task({ status: "completed", ended_at: "2026-10-02T04:00:00Z" }), at)).toBeNull();
});

test("elapsed time reads in seconds, minutes, then hours", () => {
  expect([formatElapsed(8_400), formatElapsed(252_000), formatElapsed(3_780_000)]).toEqual(["8s", "4m 12s", "1h 3m"]);
});

test("a PC whose clock runs an hour ahead: its offset puts a running task's time right", () => {
  const browser = Date.parse("2026-10-02T04:04:12Z");
  const offset = clockOffsetMs("2026-10-02T05:04:12Z", browser);
  expect(offset).toBe(3_600_000);
  expect(taskElapsedMs(task({}), browser)).toBeNull();
  expect(taskElapsedMs(task({}), browser + offset)).toBe(252_000);
  expect(clockOffsetMs(null, browser)).toBe(0);
  expect(clockOffsetMs("not a time", browser)).toBe(0);
});
