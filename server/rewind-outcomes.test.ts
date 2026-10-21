import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import { followClaudeRestore } from "./rewind.ts";
import { commandInvocations } from "./outcome.ts";
import { CLAUDE_REWIND_CHOICES } from "./dialogs/claude.ts";
import type { ParsedPrompt } from "./dialogs/shared.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

afterEach(() => mock.restore());

it("forgets the outcomes of the chat's sends after a restore's point, and keeps the ones before it", async () => {
  const start = Date.now() - 60_000;
  const pane = { pane_id: "rewind-outcomes", terminal_id: "terminal", workspace_id: "w", tab_id: "t",
    cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  spyOn(client, "sessionSnapshot").mockResolvedValue({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture" });
  // Claude Code right after Restore conversation on apple: the message is back in its input box
  const restored = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-40.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  spyOn(conversation, "readCommandTranscript").mockResolvedValue({ identity: "fixture", records: [] });
  const send = (id: string, text: string, after: number) => noteSubmitted(pane.pane_id, text, { id, text, at: start + after, agent: "claude", screen: "",
    store: null, identity: JSON.stringify([pane.terminal_id, undefined]), form: null, invocations: commandInvocations("claude", text, []) });
  send("before", "/context", 0);
  send("after", "/context", 30_000);
  const shown = async () => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
    return ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes?.map(({ id }) => id) ?? [];
  };
  expect(await shown()).toEqual(["before", "after"]);
  // the message restored was written to the transcript between the two sends: the later one was rewound away with it
  spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue({ said: "apple", at: start + 10_000 });
  await followClaudeRestore(pane.pane_id, { menuLabels: [...CLAUDE_REWIND_CHOICES], body: "apple\n\nThe conversation will be forked." } as unknown as ParsedPrompt, 2_000);
  expect(await shown()).toEqual(["before"]);
});

it("records a restore from a dialog the chat did not open only as the message's one copy, never the newest of several", async () => {
  const pane = { pane_id: "rewind-foreign", terminal_id: "terminal", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };
  const restored = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-restored-40.txt", import.meta.url), "utf8");
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: restored, source: "detection", format: "text", truncated: false });
  const recorded = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  await followClaudeRestore(pane.pane_id, { menuLabels: [...CLAUDE_REWIND_CHOICES], body: "apple\n\nThe conversation will be forked." } as unknown as ParsedPrompt, 2_000);
  expect(recorded.mock.calls).toEqual([[pane.pane_id, "apple", null]]);
});
