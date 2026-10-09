import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoProgressRecords, parseTodos, PROGRESS_READ_BUDGET } from "./omo-progress-records.ts";

const root = mkdtempSync(join(tmpdir(), "omo-progress-records-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const data = (content = "current", status = "in_progress") => ({
  schema: "v2", phases: [{ name: "Build", tasks: [{ content, status }] }],
});
const todo = (id: string, parentId: string | null, state: unknown = data()) =>
  JSON.stringify({ type: "custom", id, parentId, timestamp: "2026-10-04T12:00:00Z", customType: "senpi.todo-state", data: state });
const message = (id: string, parentId: string | null, role = "user", text = "", stopReason?: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-04T12:00:10Z", message: { role, content: [{ type: "text", text }], stopReason } });
const lines = (...entries: string[]) => entries.join("\n") + "\n";

describe("canonical progress records", () => {
  it("parses every status, empty phases and clear, but rejects an invalid whole state", () => {
    const states = ["pending", "in_progress", "completed", "abandoned"] as const;
    for (const status of states) expect(parseTodos(data(status, status))).toEqual([{ phase: "Build", content: status, status }]);
    expect(parseTodos({ schema: "v2", phases: [] })).toEqual([]);
    expect(parseTodos({ schema: "v2", phases: [{ name: "Empty", tasks: [] }] })).toEqual([]);
    for (const invalid of [null, { schema: "v1", phases: [] }, data("bad", "running"), { schema: "v2", phases: [{}] }])
      expect(parseTodos(invalid)).toBeNull();
  });

  it("finds a todo before large transcript pages and ignores malformed later state", () => {
    // Given: the canonical state is far outside the last transcript page.
    const path = join(root, "pages.jsonl");
    writeFileSync(path, lines(todo("a", null), message("b", "a", "user", "x".repeat(2 * 1024 * 1024)),
      todo("c", "b", data("broken", "bogus")), message("d", "c", "assistant", "", "stop")));
    // When: progress reads the session, not the conversation page.
    const found = new OmoProgressRecords().read(path);
    // Then: the latest valid list and completed turn survive oversized messages.
    expect(found.todos).toEqual([{ phase: "Build", content: "current", status: "in_progress" }]);
    expect(found.turn.status).toBe("idle");
  });

  it("uses the new branch rather than the task on an abandoned branch", () => {
    const path = join(root, "branch.jsonl");
    writeFileSync(path, lines(todo("root", null, data("root", "completed")), todo("old", "root", data("left")),
      message("leaf", "root")));
    expect(new OmoProgressRecords().read(path).todos).toEqual([{ phase: "Build", content: "root", status: "completed" }]);
  });

  it("does not resurrect a side branch when its parent cannot be read", () => {
    const path = join(root, "missing-parent.jsonl");
    writeFileSync(path, lines(todo("old", null), message("new", "absent")));
    expect(new OmoProgressRecords().read(path).todos).toBeNull();
  });

  it("retains a clear and incrementally waits for a torn final line", () => {
    const path = join(root, "clear.jsonl");
    const reader = new OmoProgressRecords();
    writeFileSync(path, lines(todo("a", null)));
    reader.read(path);
    appendFileSync(path, todo("b", "a", { schema: "v2", phases: [] }));
    expect(reader.read(path).todos?.[0]?.content).toBe("current");
    appendFileSync(path, "\n");
    expect(reader.read(path).todos).toEqual([]);
  });

  it("invalidates an in-place same-size rewrite, growing rewrite and inode replacement", () => {
    const path = join(root, "rewrite.jsonl");
    const reader = new OmoProgressRecords();
    writeFileSync(path, lines(todo("a", null, data("first"))));
    reader.read(path);
    writeFileSync(path, lines(todo("b", null, data("other"))));
    expect(reader.read(path).todos?.[0]?.content).toBe("other");
    writeFileSync(path, lines(todo("c", null, data("longer replacement"))));
    expect(reader.read(path).todos?.[0]?.content).toBe("longer replacement");
    const replacement = join(root, "replacement.jsonl");
    writeFileSync(replacement, lines(todo("d", null, { schema: "v2", phases: [] })));
    renameSync(replacement, path);
    expect(reader.read(path).todos).toEqual([]);
  });

  it("bounds each incremental read and makes progress through a record larger than the budget", () => {
    const path = join(root, "huge.jsonl");
    const reader = new OmoProgressRecords();
    writeFileSync(path, lines(todo("a", null), message("b", "a", "user", "x".repeat(PROGRESS_READ_BUDGET + 100)),
      todo("c", "b", data("latest"))));
    expect(reader.read(path).todos).toBeNull();
    expect(reader.read(path).todos?.[0]?.content).toBe("latest");
    expect(reader.read(path).todos?.[0]?.content).toBe("latest");
  });

  it("returns unknown after deletion instead of the cached active task", () => {
    const path = join(root, "deleted.jsonl");
    const reader = new OmoProgressRecords();
    writeFileSync(path, lines(todo("a", null)));
    reader.read(path);
    rmSync(path);
    expect(reader.read(path).todos).toBeNull();
  });
});
