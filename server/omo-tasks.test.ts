import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { omoTasks } from "./omo-tasks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = Date.parse("2026-10-02T06:00:00Z");
const SESSION = "01a0fafe-00cc-7ff6-aed6-74582533a347";
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function folder(records: Record<string, unknown>[], extra: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "omo-tasks-"));
  dirs.push(cwd);
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  mkdirSync(dir, { recursive: true });
  records.forEach((record, index) => writeFileSync(join(dir, `st_${index}.json`), JSON.stringify({ task_id: `st_${index}`, parent_session_id: SESSION, host_pid: 1, ...record })));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return cwd;
}
const alive = () => true;

test("a session's tasks: running oldest first, then ended newest first, with what the record says about each", () => {
  const cwd = folder([
    { status: "completed", task_summary: "older done", started_at: ago(50), terminal_at: ago(40), run_stats: { turns: 3, tool_calls: 9, total_tokens: 1200 }, category: "quick", resolved_model: { display: "Claude Haiku 4.5" }, spawn_spec: { prompt: "SECRET PROMPT" }, final_response: "SECRET ANSWER" },
    { status: "running", description: "second", started_at: ago(2) },
    { status: "running", name: "first", started_at: ago(5), agent_type: "explore", model: "anthropic/x" },
    { status: "cancelled", task_summary: "newer cancelled", started_at: ago(20), terminal_at: ago(10) },
  ]);
  const tasks = omoTasks(cwd, SESSION, alive, NOW);
  expect(tasks.map((task) => [task.title, task.status])).toEqual([["first", "running"], ["second", "running"], ["newer cancelled", "cancelled"], ["older done", "completed"]]);
  expect(tasks[0]).toMatchObject({ category: "explore", model: "anthropic/x", ended_at: null });
  expect(tasks[3]).toEqual({ id: "st_0", title: "older done", category: "quick", model: "Claude Haiku 4.5", status: "completed", started_at: ago(50), ended_at: ago(40), turns: 3, tool_calls: 9, tokens: 1200 });
  expect(JSON.stringify(tasks)).not.toContain("SECRET");
});

test("another session's tasks, old ones, unknown states and torn files stay out; a dead host's task reads lost", () => {
  const cwd = folder([
    { status: "running", task_summary: "other session", parent_session_id: "someone-else" },
    { status: "completed", task_summary: "two days ago", terminal_at: ago(48 * 60) },
    { status: "paused-ish", task_summary: "unknown state" },
    { status: "running", task_summary: "host gone", host_pid: 999_999, started_at: ago(30) },
    { status: "completed", task_summary: "no time at all" },
  ], { "st_torn.json": "{\"task_id\": \"st_t", "notes.txt": "x" });
  const tasks = omoTasks(cwd, SESSION, (pid) => pid !== 999_999, NOW);
  expect(tasks.map((task) => [task.title, task.status])).toEqual([["host gone", "lost"]]);
});

test("no task folder, and at most ten ended tasks", () => {
  expect(omoTasks(join(tmpdir(), "no-such-folder-omo"), SESSION, alive, NOW)).toEqual([]);
  const cwd = folder(Array.from({ length: 14 }, (_, index) => ({ status: "completed", task_summary: `done ${index}`, terminal_at: ago(index) })));
  const tasks = omoTasks(cwd, SESSION, alive, NOW);
  expect(tasks.length).toBe(10);
  expect(tasks[0]!.title).toBe("done 0");
});

test("only plain files are read: a link, a pipe and an oversized record are passed over", () => {
  const cwd = folder([{ status: "running", task_summary: "plain" }]);
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  const outside = join(cwd, "outside.json");
  writeFileSync(outside, JSON.stringify({ task_id: "st_x", parent_session_id: SESSION, status: "running", task_summary: "through a link" }));
  symlinkSync(outside, join(dir, "st_link.json"));
  expect(Bun.spawnSync(["mkfifo", join(dir, "st_pipe.json")]).exitCode).toBe(0);
  writeFileSync(join(dir, "st_huge.json"), JSON.stringify({ task_id: "st_h", parent_session_id: SESSION, status: "running", task_summary: "huge", pad: "x".repeat(1024 * 1024) }));
  expect(omoTasks(cwd, SESSION, alive, NOW).map((task) => task.title)).toEqual(["plain"]);
});

test("a folder of thousands of tasks: the newest are read, and this session's running one is among them", () => {
  const cwd = folder([]);
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  for (let index = 0; index < 2100; index++) writeFileSync(join(dir, `st_00${String(index).padStart(6, "0")}.json`), JSON.stringify({ task_id: `st_${index}`, parent_session_id: "someone-else", status: "completed" }));
  writeFileSync(join(dir, "st_01a0ffff.json"), JSON.stringify({ task_id: "st_01a0ffff", parent_session_id: SESSION, status: "running", task_summary: "mine" }));
  expect(omoTasks(cwd, SESSION, alive, NOW).map((task) => task.title)).toEqual(["mine"]);
});

test("a rewritten record is read again, and a host that dies after it was read makes it lost", () => {
  const cwd = folder([{ status: "running", task_summary: "work", updated_at: ago(1) }]);
  const path = join(cwd, ".omo", "senpi-task", "tasks", "st_0.json");
  let up = true;
  expect(omoTasks(cwd, SESSION, () => up, NOW)[0]).toMatchObject({ status: "running", ended_at: null });
  up = false;
  expect(omoTasks(cwd, SESSION, () => up, NOW)[0]).toMatchObject({ status: "lost", ended_at: ago(1) });
  writeFileSync(path, JSON.stringify({ task_id: "st_0", parent_session_id: SESSION, host_pid: 1, status: "completed", task_summary: "work", terminal_at: ago(0) }));
  utimesSync(path, NOW / 1000 + 5, NOW / 1000 + 5);
  expect(omoTasks(cwd, SESSION, () => up, NOW)[0]).toMatchObject({ status: "completed", ended_at: ago(0) });
});

test("a task still running under thousands of newer records is found, over a few polls at most", () => {
  const cwd = folder([]);
  const dir = join(cwd, ".omo", "senpi-task", "tasks");
  writeFileSync(join(dir, "st_00000000.json"), JSON.stringify({ task_id: "st_00000000", parent_session_id: SESSION, status: "running", task_summary: "old but running" }));
  for (let index = 1; index <= 2500; index++) writeFileSync(join(dir, `st_${String(index).padStart(8, "0")}.json`), JSON.stringify({ task_id: `st_${index}`, parent_session_id: "someone-else", status: "completed", pad: "x".repeat(4000) }));
  let titles: string[] = [];
  for (let poll = 0; poll < 5 && titles.length === 0; poll++) titles = omoTasks(cwd, SESSION, alive, NOW).map((task) => task.title);
  expect(titles).toEqual(["old but running"]);
});
