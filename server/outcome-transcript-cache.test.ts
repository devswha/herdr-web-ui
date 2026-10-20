import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as conversation from "./conversation.ts";

it("shares unchanged command transcript reads across viewers and reads only appended bytes", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-transcript-cache-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", timestamp: "2026-10-20T00:00:00Z", modelId }) + "\n";
  fs.writeFileSync(path, record("old").repeat(10_000));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    const first = await conversation.readCommandTranscript("viewer-one");
    reads.mockClear();
    parses.mockClear();
    expect(await conversation.readCommandTranscript("viewer-two")).toBe(first);
    expect(reads.mock.calls).toHaveLength(0);
    expect(parses.mock.calls).toHaveLength(0);
    fs.appendFileSync(path, record("new"));
    await conversation.readCommandTranscript("viewer-two");
    const bytes = reads.mock.results.reduce((sum, result) => sum + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0);
    expect(bytes).toBeLessThan(1024);
    expect(parses.mock.calls.length).toBeLessThan(5);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("invalidates rewritten and replaced transcripts and completes a torn tail only once", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-transcript-rewrite-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", timestamp: "2026-10-20T00:00:00Z", modelId }) + "\n";
  fs.writeFileSync(path, record("old"));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  try {
    const first = await conversation.readCommandTranscript("viewer");
    const next = record("new");
    fs.appendFileSync(path, next.slice(0, 20));
    expect((await conversation.readCommandTranscript("viewer"))?.records).toHaveLength(1);
    fs.appendFileSync(path, next.slice(20));
    const completed = await conversation.readCommandTranscript("viewer");
    expect(completed?.records.map(({ entry }) => entry.modelId)).toEqual(["old", "new"]);
    expect(await conversation.readCommandTranscript("another-viewer")).toBe(completed);
    fs.writeFileSync(path, record("replacement"));
    const rewritten = await conversation.readCommandTranscript("viewer");
    expect(rewritten?.identity).not.toBe(first?.identity);
    expect(rewritten?.records.map(({ entry }) => entry.modelId)).toEqual(["replacement"]);
    const replacement = join(root, "replacement.jsonl");
    fs.writeFileSync(replacement, record("other-inode"));
    fs.renameSync(replacement, path);
    const replaced = await conversation.readCommandTranscript("viewer");
    expect(replaced?.identity).not.toBe(rewritten?.identity);
    expect(replaced?.records.map(({ entry }) => entry.modelId)).toEqual(["other-inode"]);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
