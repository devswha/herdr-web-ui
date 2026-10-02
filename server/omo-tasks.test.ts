import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    { status: "running", task_summary: "host gone", host_pid: 999_999 },
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
