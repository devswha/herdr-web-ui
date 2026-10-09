import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmoControl } from "./omo-control.ts";
import { OmoProgressRecords } from "./omo-progress-records.ts";
import { OmoProgressReader, visibleCompaction } from "./omo-progress.ts";

const root = mkdtempSync(join(tmpdir(), "omo-progress-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const border = "─".repeat(60);
const screen = (label: string) => `conversation\n── ⠋ ${label} ─────\n❯ \n${border}\nproject | context 50%\n`;

describe("older TUI compaction fallback", () => {
  for (const label of [
    "Compacting context... (esc to cancel)",
    "Context overflow detected, compacting... (esc to cancel)",
    "Compacting before next prompt... (esc to cancel)",
    "Auto-compacting... (esc to cancel)",
    "Compacting... (esc to cancel)",
  ]) {
    it(`recognizes a live composer indicator for ${label}`, () => {
      expect(visibleCompaction(screen(label))).toBe("compacting");
    });
  }
  it("rejects quoted, finished, missing-spinner and old conversation content", () => {
    const label = "Compacting context... (esc to cancel)";
    for (const quoted of [
      `The runtime says '${label}'`, `> ── ⠋ ${label} ───`,
      `\`\`\`\n${screen(label)}\`\`\``,
      `\`\`\`\n${screen(label)}\`\`\`\n${border}\n❯ \n${border}\n`,
      screen(label).replace("⠋", "✓"), screen(label) + "Assistant finished\n".repeat(14),
      `── ⠋ ${label} ───\nThis is a quote, not the editor\n${border}\n`,
    ]) expect(visibleCompaction(quoted)).not.toBe("compacting");
    expect(visibleCompaction(`"${label}"`)).toBe("unknown");
    expect(visibleCompaction("ordinary working text")).toBeNull();
  });
});

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

  it("prefers matching native state and does not read the visible pane", async () => {
    records("assistant");
    class Native extends OmoControl { override async activity() { return "retrying" as const; } }
    const reader = new OmoProgressReader(new OmoProgressRecords(), new Native());
    expect(await reader.read(session, async () => { throw new Error("must not read"); })).toEqual({
      session_id: "mine", todos: [{ phase: "Build", content: "work", status: "in_progress" }], activity: "retrying",
    });
  });

  it("uses transcript working/idle and does not infer retry from an error", async () => {
    const reader = new OmoProgressReader(new OmoProgressRecords(), new OmoControl(join(root, "no-sockets")));
    records("user");
    expect((await reader.read(session, async () => "")).activity).toBe("working");
    records("assistant");
    expect((await reader.read(session, async () => "")).activity).toBe("idle");
  });

  it("uses live compaction instead of a finished transcript turn", async () => {
    records("assistant");
    const reader = new OmoProgressReader(new OmoProgressRecords(), new OmoControl(join(root, "no-sockets")));
    expect((await reader.read(session, async () => screen("Compacting context... (esc to cancel)"))).activity).toBe("compacting");
  });

  it("preserves a resumed checklist without calling its old turn active, and reports failed reads as unknown", async () => {
    records("user", "2026-10-04T10:00:00Z");
    const reader = new OmoProgressReader(new OmoProgressRecords(), new OmoControl(join(root, "no-sockets")));
    expect(await reader.read(session, async () => "")).toEqual({
      session_id: "mine", todos: [{ phase: "Build", content: "work", status: "in_progress" }], activity: "idle",
    });
    expect((await reader.read(session, async () => { throw new Error("pane gone"); })).activity).toBe("unknown");
  });
});
