import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultPiSessionDir, piTranscriptInStore } from "./pi.ts";
import { transcriptPage } from "./conversation.ts";
import type { ConversationTurn } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-store-"));
const store = join(root, "sessions");
const slug = join(store, `--${root.replaceAll("/", "-")}--`);
mkdirSync(slug, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const session = (name: string, body: unknown[] = []) => {
  const path = join(slug, `${name}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: root },
    ...body,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
};

describe("pi's session store holds the transcript a pane reads", () => {
  it("accepts a session file inside the store", () => {
    const path = session("inside");
    expect(piTranscriptInStore(path, store)).toBe(path);
  });

  it("refuses paths that leave the store", () => {
    const outside = join(root, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    expect(piTranscriptInStore(outside, store)).toBeNull();
    expect(piTranscriptInStore(join(store, "..", "elsewhere.jsonl"), store)).toBeNull();
    expect(piTranscriptInStore(store, store)).toBeNull();
    expect(piTranscriptInStore(join(root, "missing.jsonl"), store)).toBeNull();
  });

  it("refuses a link out of the store, a directory and a file that is not jsonl", () => {
    const outside = join(root, "target.jsonl");
    writeFileSync(outside, "{}\n");
    const link = join(slug, "link.jsonl");
    symlinkSync(outside, link);
    expect(piTranscriptInStore(link, store)).toBeNull();
    mkdirSync(join(slug, "dir.jsonl"), { recursive: true });
    expect(piTranscriptInStore(join(slug, "dir.jsonl"), store)).toBeNull();
    const other = join(slug, "notes.txt");
    writeFileSync(other, "{}\n");
    expect(piTranscriptInStore(other, store)).toBeNull();
  });

  it("follows PI_CODING_AGENT_SESSION_DIR the way Codex follows CODEX_HOME", () => {
    const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
    process.env["PI_CODING_AGENT_SESSION_DIR"] = store;
    try { expect(defaultPiSessionDir()).toBe(store); } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
      else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
    }
  });
});

// pi's own record shapes: a system prompt that stays hidden, a prompt, an assistant
// turn whose thinking, prose and calls sit side by side, and results answering by id.
const conversation = [
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00.000Z", provider: "test", modelId: "qwen-test" },
  { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-30T00:00:00.000Z", thinkingLevel: "medium" },
  { type: "message", id: "s1", parentId: "t1", timestamp: "2026-09-30T00:00:01.000Z", message: { role: "system", content: "instructions the chat must not show" } },
  { type: "message", id: "u1", parentId: "s1", timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "fix the crash" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse",
    usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420 },
    content: [
      { type: "thinking", thinking: "the null check is missing" },
      { type: "text", text: "I'll add the guard." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
    ],
  } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z", message: {
    role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export const app = null;" }],
  } },
  { type: "message", id: "a2", parentId: "r1", timestamp: "2026-09-30T00:00:05.000Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop",
    usage: { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, totalTokens: 480 },
    content: [{ type: "text", text: "Guarded. The crash came from a null export." }],
  } },
];

describe("pi transcripts render as chat", () => {
  it("reads prompts, thinking, tool results and recorded settings", () => {
    const page = transcriptPage("pi-transcript", session("readable", conversation));
    expect(page.source).toBe("pi-transcript");
    expect(page.metadata).toEqual({ model: "qwen-test", reasoning_effort: "medium", context: { used: 450, window: null } });
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);

    const [prompt, answer] = page.turns as [ConversationTurn, ConversationTurn];
    expect(prompt.parts).toEqual([{ kind: "text", text: "fix the crash" }]);
    expect(answer.parts.map((part) => part.kind)).toEqual(["thinking", "text", "tool", "text"]);
    const tool = answer.parts.find((part) => part.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("expected a tool part");
    expect([tool.name, tool.summary, tool.output]).toEqual(["read", "src/app.ts", "export const app = null;"]);
    // the system prompt is hidden context, never an assistant message
    expect(JSON.stringify(page.turns)).not.toContain("instructions the chat must not show");
  });

  it("shows a failed request instead of a prompt with no answer", () => {
    const page = transcriptPage("pi-transcript", session("failed", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized" } },
    ]));
    expect(page.turns[1]!.parts).toEqual([{ kind: "text", text: "Error: 401 unauthorized" }]);
  });

  it("starts a fresh history when /new or /resume moves the pane to another file", () => {
    // pi writes no marker for these: a new session is a new file, and herdr re-reports it.
    const before = transcriptPage("pi-transcript", session("first", conversation));
    const after = transcriptPage("pi-transcript", session("second", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:10:00.000Z", message: { role: "user", content: "new topic" } },
    ]));
    expect(after.history_id).not.toBe(before.history_id);
    expect(after.turns).toHaveLength(1);
    // a cursor into the abandoned file cannot page the new one
    expect(() => transcriptPage("pi-transcript", join(slug, "second.jsonl"), { before: before.cursor! })).toThrow();
  });

  // pi folds old context into a summary of its own accord and on /compact. The entry is a
  // tree entry rather than a message, so without a branch of its own it showed as nothing:
  // the chat ran from a prompt straight to an answer with the middle quietly gone.
  it("marks where /compact folded the conversation, with its summary", () => {
    const path = session("compacted", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "the first question" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "## Session Goal\n- fold the older turns", firstKeptEntryId: "u1", tokensBefore: 178366 },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "user", content: "and now the next one" } },
    ]);
    const page = transcriptPage("pi-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind)))
      .toEqual([["text"], ["compact"], ["text"]]);
    const card = page.turns[1]!.parts[0]!;
    expect(card).toEqual({ kind: "compact", text: "## Session Goal\n- fold the older turns" });
    expect(page.turns[1]!.role).toBe("user");
  });

  it("keeps a compaction a /tree navigated away from out of the chat", () => {
    const body = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "the first question" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "the fold on the branch left behind" },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "user", content: "a turn on that branch" } },
    ];
    const path = session("compacted-then-navigated", body);
    expect(transcriptPage("pi-transcript", path).turns.filter((turn) => turn.parts.some((part) => part.kind === "compact"))).toHaveLength(1);
    // /tree back to the first prompt: the fold sits above the new answer's branch, unread
    appendFileSync(path, JSON.stringify({
      type: "message", id: "a2", parentId: "u1", timestamp: "2026-09-30T00:10:00.000Z",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "the answer in play" }] },
    }) + "\n");
    const page = transcriptPage("pi-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"], ["text"]]);
  });

  it("shows nothing for a compaction whose summary was never written", () => {
    const path = session("compaction-empty", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "", firstKeptEntryId: "u1" },
    ]);
    expect(transcriptPage("pi-transcript", path).turns).toHaveLength(1);
  });
});
