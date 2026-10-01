import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { piBranchSegments, piEntryIndex } from "./pi-tree.ts";
import { transcriptPage, transcriptToolOutput } from "./conversation.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-tree-"));
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** pi writes one entry per line: an id, a parentId, and whatever the type carries. */
const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({ id, parentId, timestamp: "2026-09-30T00:00:00.000Z", ...extra });
const user = (id: string, parentId: string | null, text: string) => entry(id, parentId, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string | null, text: string) => entry(id, parentId, { type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

let counter = 0;
const file = (entries: unknown[]) => {
  const path = join(root, `session-${++counter}.jsonl`);
  writeFileSync(path, entries.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};
/** What the chat shows, across every page: the conversation is what a reader can reach. */
const shown = (path: string) => {
  const turns: string[] = [];
  let page = transcriptPage("pi-transcript" as never, path);
  let guard = 0;
  for (;;) {
    for (const turn of page.turns) {
      const text = turn.parts.find((part) => part.kind === "text");
      if (text?.kind === "text") turns.push(`${turn.role}:${text.text}`);
    }
    if (typeof page.cursor !== "string" || guard++ > 40) break;
    page = transcriptPage("pi-transcript" as never, path, { before: page.cursor });
  }
  return turns;
};
const branchOf = (path: string) => piBranchSegments(path, statSync(path).size);

describe("pi's entry tree", () => {
  it("reads a straight line as the whole file", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "first"),
      assistant("a1", "u1", "answer one"),
      user("u2", "a1", "second"),
      assistant("a2", "u2", "answer two"),
    ]);
    expect(branchOf(path)).toEqual([{ start: 0, end: statSync(path).size }]);
    expect(shown(path)).toEqual(["user:first", "assistant:answer one", "user:second", "assistant:answer two"]);
  });

  it("shows only the branch the leaf stands on after /tree", () => {
    // two answers branched from one prompt: pi keeps both in the file, runs the last one
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    const branch = branchOf(path)!;
    // ranges merge when consecutive, so this is [session] then [u2, a-live]: u1 and
    // a-gone sit between the session and the branch and are read by neither
    expect(branch).toHaveLength(2);
    expect(shown(path)).toEqual(["user:the retried question", "assistant:the answer in play"]);
    expect(shown(path).join(" ")).not.toContain("abandoned");
    expect(shown(path).join(" ")).not.toContain("the question");
  });

  it("moves the conversation when a /tree branch is appended, and invalidates the page", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
      assistant("a1", "u1", "first answer"),
    ]);
    const before = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:first answer"]);
    // the leaf moves back to the prompt and a new answer is written beside the old one
    appendFileSync(path, JSON.stringify(assistant("a2", "u1", "second answer")) + "\n");
    const after = transcriptPage("pi-transcript" as never, path);
    expect(after.history_id).not.toBe(before.history_id); // same file, same inode: only the tree knows
    expect(shown(path)).toEqual(["user:question", "assistant:second answer"]);
    // a cursor held from the branch that was navigated away from cannot page the new one
    expect(() => transcriptPage("pi-transcript" as never, path, { before: before.cursor! })).toThrow();
  });

  it("keeps history_id stable while a branch only grows", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
    ]);
    const first = transcriptPage("pi-transcript" as never, path);
    appendFileSync(path, JSON.stringify(assistant("a1", "u1", "answer")) + "\n");
    expect(transcriptPage("pi-transcript" as never, path).history_id).toBe(first.history_id);
  });

  it("tells two /tree moves apart when their branches share every range but the last", () => {
    // one file, the leaf moved twice. Both states read the merged head plus one tail that
    // starts at a different byte; only that start separates them, and the tail's end is
    // what grows with appends, so the layout counts starts and non-final ends.
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
      assistant("a1", "u1", "the answer first written"),
    ]);
    appendFileSync(path, JSON.stringify(assistant("a2", "u1", "the second")) + "\n");
    const second = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:the second"]);
    // /tree back to the prompt again, and a third answer beside the other two
    appendFileSync(path, JSON.stringify(assistant("a3", "u1", "the third")) + "\n");
    const third = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:the third"]);
    expect(third.history_id).not.toBe(second.history_id);
    // the page held from the branch that was navigated away from no longer pages this one
    expect(() => transcriptPage("pi-transcript" as never, path, { before: second.cursor! })).toThrow();
  });

  it("indexes an append without rereading what it already scanned", () => {
    const path = file([entry("s", null, { type: "session", version: 3, id: "s", cwd: root }), user("u1", "s", "one")]);
    const first = piEntryIndex(path)!;
    const scanned = first.scanned;
    appendFileSync(path, JSON.stringify(assistant("a1", "u1", "two")) + "\n");
    const next = piEntryIndex(path)!;
    expect(next).toBe(first); // the same index, extended
    expect(next.scanned).toBeGreaterThan(scanned);
    expect(next.entries.map((e) => e.id)).toEqual(["s", "u1", "a1"]);
  });

  it("starts over when the file is rewritten or cut, so a stale tree cannot be read", () => {
    const path = file([entry("s", null, { type: "session", version: 3, id: "s", cwd: root }), user("u1", "s", "one"), assistant("a1", "u1", "two")]);
    piEntryIndex(path);
    truncateSync(path, 60);
    const index = piEntryIndex(path)!;
    expect(index.entries.length).toBeLessThan(3);
  });

  it("stops at a parent it cannot find instead of inventing the head of the branch", () => {
    const path = file([user("u2", "missing-parent", "a turn whose parent never appears"), assistant("a2", "u2", "answer")]);
    expect(branchOf(path)).toHaveLength(1); // u2 and a2, merged; nothing above the unknown id
    expect(shown(path)).toEqual(["user:a turn whose parent never appears", "assistant:answer"]);
  });

  it("ignores the header and entries without an id, and keeps the last of a repeated id", () => {
    const path = file([
      { type: "session", version: 3, id: "s", cwd: root }, // no parentId: not a node
      user("u1", null, "only prompt"),
      assistant("u1", "u1", "an id reused"),
    ]);
    const branch = branchOf(path)!;
    expect(branch).toHaveLength(1); // the repeat wins, and its parent is itself: the walk stops
    expect(piEntryIndex(path)!.entries.map((e) => e.id)).toEqual(["s", "u1", "u1"]); // indexed twice, resolved once
  });

  it("holds nothing to show for an empty file", () => {
    expect(piBranchSegments(join(root, "never-written.jsonl"), 0)).toBeNull();
    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "");
    expect(piBranchSegments(empty, 0)).toBeNull();
  });

  it("reads a tool's output along the branch, and never one a /tree left behind", () => {
    const call = (id: string, parentId: string, callId: string) => entry(id, parentId, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" } });
    const result = (id: string, parentId: string, callId: string, text: string) => entry(id, parentId, { type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }] } });
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "list the files"),
      call("a1", "u1", "call-1"),
      result("r1", "a1", "call-1", "the first output, kept"),
      assistant("a2", "r1", "the answer in play"),
      // a question, then a /tree back to a2 that drops it and its tool call
      user("u2", "a2", "the question a /tree dropped"),
      call("a3", "u2", "call-2"),
      result("r2", "a3", "call-2", "the output a /tree dropped"),
      user("u3", "a2", "what about the other folder"),
      call("a4", "u3", "call-3"),
      result("r3", "a4", "call-3", "the newest output"),
    ]);
    // the leaf is r3: s, u1, a1, r1, a2, u3, a4, r3. u2 and its call never appear.
    expect(shown(path)).toEqual(["user:list the files", "assistant:the answer in play", "user:what about the other folder"]);
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-1")).toBe("the first output, kept");
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-3")).toBe("the newest output");
    // the dropped call's output stays unreachable: the chat never showed that call
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-2")).toBeNull();
  });
});
