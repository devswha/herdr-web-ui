import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as conversation from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { commandInvocations, commandOutcome } from "./outcome.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

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

it("does not complete /context through the prompt route after its cached echo is replaced by a larger /version transcript", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-route-rewrite-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = (name: string) => JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + 10).toISOString(),
    content: `<command-name>${name}</command-name>\n<command-message>command</command-message>` }) + "\n";
  fs.writeFileSync(path, echo("/context"));
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "claude", agent_status: "idle", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const sent = { id: "route-context", text: "/context", at, agent: "claude",
    identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
    invocations: commandInvocations("claude", "/context", []) };
  try {
    noteSubmitted(pane.pane_id, sent.text, sent);
    const cached = await conversation.readCommandTranscript(pane.pane_id);
    fs.writeFileSync(path, echo("/version") + JSON.stringify({ type: "system", subtype: "local_command",
      timestamp: new Date(at + 20).toISOString(), content: "<local-command-stdout>fixture-version-output</local-command-stdout>" }) + "\n");
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const response = await handlePromptRequest(new Request(url), url);
    const shown = await response?.json() as PanePromptResponse;
    expect(shown.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    const rewritten = await conversation.readCommandTranscript(pane.pane_id);
    expect(rewritten?.identity).not.toBe(cached?.identity);
    expect(rewritten?.records).toHaveLength(2);
    fs.appendFileSync(path, JSON.stringify({ type: "model_change", timestamp: new Date(at + 40).toISOString(), modelId: "fixture" }) + "\n");
    const appended = await conversation.readCommandTranscript(pane.pane_id);
    expect(appended?.identity).toBe(rewritten?.identity);
    expect(appended?.records).toHaveLength(3);
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the complete record's rewrite guard across a torn append", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-partial-boundary-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = (name: string) => JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + 10).toISOString(),
    content: `<command-name>${name}</command-name>\n<command-message>command</command-message>` }) + "\n";
  const stdout = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 20).toISOString(),
    content: "<local-command-stdout>fixture-output</local-command-stdout>" }) + "\n";
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path });
  try {
    fs.writeFileSync(path, echo("/context"));
    await conversation.readCommandTranscript("one");
    fs.appendFileSync(path, stdout.slice(0, 50));
    await conversation.readCommandTranscript("one");
    fs.writeFileSync(path, echo("/version") + stdout);
    const rewritten = await conversation.readCommandTranscript("two");
    const sent = { id: "context", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null,
      invocations: commandInvocations("claude", "/context", []) };
    expect(commandOutcome("pane", sent, { now: at + 30, transcript: rewritten?.records }).state).toBe("accepted");
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
