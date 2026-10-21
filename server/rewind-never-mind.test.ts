import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as client from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { claudeRewindOnScreen } from "./dialogs/claude.ts";
import { followClaudeNeverMind } from "./rewind.ts";

afterEach(() => mock.restore());

const recorded = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}-40.txt`, import.meta.url), "utf8");
const pane = { pane_id: "never-mind", terminal_id: "terminal", workspace_id: "w", tab_id: "t", cwd: "/fixture", focused: false, revision: 0, agent: "claude", agent_status: "idle" };

/**
 * Claude Code after the card's Never mind (its Esc, recorded): back on the list; one more Esc closes the
 * list (recorded). herdr's client asks a write's guard once connected, right before writing.
 */
function claudeAfterNeverMind(screen: string, beforeWrite: () => void = () => {}) {
  const state = { screen, keys: [] as string[][] };
  spyOn(client, "paneRead").mockImplementation(async () => ({ ...pane, text: state.screen, source: "detection" as const, format: "text" as const, truncated: false }));
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys, _socket, guard) => {
    beforeWrite();
    if (guard !== undefined && !guard()) throw new HerdrError("cancelled", "herdr pane.send_keys was not sent");
    state.keys.push(keys);
    if (keys[0] === "esc" && claudeRewindOnScreen(state.screen)) state.screen = recorded("confirm-apple-esc-esc");
  });
  return state;
}

it("closes the list Never mind went back to with one more Esc, and ends with no dialog and no record", async () => {
  const record = spyOn(conversation, "rewindClaudeTranscript").mockResolvedValue(null);
  const claude = claudeAfterNeverMind(recorded("confirm-apple-restore-esc"));
  await followClaudeNeverMind(pane.pane_id, 2_000);
  expect(claude.keys).toEqual([["esc"]]);
  expect(claudeRewindOnScreen(claude.screen)).toBe(false);
  expect(record).not.toHaveBeenCalled();
});

it("sends no Esc once the list is not on screen: Claude's own input box never gets one from here", async () => {
  const claude = claudeAfterNeverMind(recorded("confirm-apple-esc-esc"));
  await followClaudeNeverMind(pane.pane_id, 60);
  expect(claude.keys).toEqual([]);
});

it("sends no second Esc for a requester gone after the first, nor one whose requester leaves while it connects", async () => {
  const gone = claudeAfterNeverMind(recorded("confirm-apple-restore-esc"));
  await followClaudeNeverMind(pane.pane_id, 2_000, () => true);
  expect(gone.keys).toEqual([]);
  mock.restore();
  let left = false;
  const leaving = claudeAfterNeverMind(recorded("confirm-apple-restore-esc"), () => { left = true; });
  await followClaudeNeverMind(pane.pane_id, 2_000, () => left).catch(() => undefined);
  expect(leaving.keys).toEqual([]);
});
