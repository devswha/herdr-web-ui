import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoProgressRecords } from "./omo-progress-records.ts";
import { OmoProgressReader } from "./omo-progress.ts";

const root = mkdtempSync(join(tmpdir(), "omo-progress-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("public progress projection", () => {
  const path = join(root, "session.jsonl");
  const session = { path, sessionId: "mine", startedAt: Date.parse("2026-10-04T12:00:00Z") };
  const records = (role: string, timestamp = "2026-10-04T12:00:10Z") => {
    writeFileSync(path, [
      JSON.stringify({ type: "custom", id: "todo", parentId: null, timestamp,
        customType: "senpi.todo-state", data: { schema: "v2", phases: [{ name: "Build", tasks: [{ content: "work", status: "in_progress" }] }] } }),
      JSON.stringify({ type: "message", id: "message", parentId: "todo", timestamp, message: { role, stopReason: "stop" } }),
    ].join("\n") + "\n");
  };

  it("uses transcript working/idle and does not infer retry from an error", () => {
    const reader = new OmoProgressReader(new OmoProgressRecords());
    records("user");
    expect(reader.read(session).activity).toBe("working");
    records("assistant");
    expect(reader.read(session).activity).toBe("idle");
  });

  it("preserves a resumed checklist without calling its old turn active", () => {
    records("user", "2026-10-04T10:00:00Z");
    const reader = new OmoProgressReader(new OmoProgressRecords());
    expect(reader.read(session)).toEqual({
      session_id: "mine", todos: [{ phase: "Build", content: "work", status: "in_progress" }], activity: "idle",
    });
  });

  it("reports an unreadable session file as unknown", () => {
    const reader = new OmoProgressReader(new OmoProgressRecords());
    expect(reader.read({ ...session, path: join(root, "missing.jsonl") })).toEqual({ session_id: "mine", todos: null, activity: "unknown" });
  });
});
