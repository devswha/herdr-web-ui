/**
 * "Rewind to here" from Chat (POST /api/pane/rewind). For Claude Code the server opens /rewind,
 * moves its list's cursor to the message the user picked, and opens that message's confirm step:
 * the claude-rewind card (server/dialogs/claude.ts) then asks what to restore, as any card does.
 * Every key is one the recordings show the dialog taking (2.1.304: ↑ moves up the list, Enter opens a
 * message's confirm step, "Never mind" there goes back to the list, Esc closes it), and each is sent
 * only after the screen shows what the one before it did. Once the card's Restore conversation is
 * seen done (the dialog gone, the message back in Claude's input box), the chat follows at once
 * (followClaudeRestore). grok and agy keep their rewinds where their readers follow them, but nothing
 * here reads their input box, so a draft there cannot be ruled out: the route refuses them, and the
 * chat offers the action for Claude Code alone.
 */
import type { ParsedPrompt } from "./dialogs/shared.ts";
import type { PaneRewindResponse } from "../shared/protocol.ts";
import { CLAUDE_REWIND_CHOICES, parseClaudeRewindConfirm, parseClaudeRewindList, type ClaudeRewindConfirm, type ClaudeRewindList } from "./dialogs/claude.ts";
import { KEY, normalizeText } from "./dialogs/shared.ts";
import { badRequest, conflictResponse, errorResponse, isCount, jsonResponse, readJsonObject } from "./http.ts";
import { agentPrompt, paneRead, paneScrollInfo, paneSendKeys } from "./herdr/client.ts";
import { paneContext } from "./pane-context.ts";
import { claudeInputBoxContent, claudeInputDraft, forgetChatSendsAfter, parseInteractivePrompt, viewportShowsLive } from "./prompt.ts";
import { rewindClaudeTranscript } from "./conversation.ts";

/** The requester disconnected: nothing more is typed for it (AGENTS.md: nothing is sent automatically after a disconnect). */
class RequesterGone extends Error {}

/** agents with a rewind of their own but no reader of their input box: refused, a draft there could join the command */
const UNREAD_INPUT = new Set(["grok", "agy"]);

/** the message each pane's rewind was walked to, for the restore that may follow (followClaudeRestore) */
const asked = new Map<string, { text: string; later: number }>();

/** how long the dialog may take to show what a key did */
const STEP_MS = 3000;
/** list rows walked at most: a session longer than this is rewound from the terminal */
const MAX_ROWS = 400;
const POLL_MS = 40;

export interface RewindIo {
  read(): Promise<string>;
  keys(keys: string[]): Promise<void>;
  command(text: string): Promise<void>;
}

export type RewindWalk = "shown" | "not_found" | "changed";

/** The list's row and the message it may stand for: whole, or cut short with `…` by a narrow pane. */
function rowMatches(label: string, text: string): boolean {
  const message = normalizeText(text);
  const shown = normalizeText(label);
  if (shown === message) return true;
  return shown.endsWith("…") && shown.length > 1 && message.startsWith(shown.slice(0, -1).trimEnd());
}

/** The confirm step quotes the whole message, which tells two messages a cut row reads the same for apart. */
function quoteMatches(confirm: ClaudeRewindConfirm, text: string): boolean {
  return confirm.message === normalizeText(text);
}

/** Reads until `accept` takes the screen, within `ms`; null when it never does. */
async function waitFor<T>(io: Pick<RewindIo, "read">, accept: (screen: string) => T | null, ms: number): Promise<T | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = accept(await io.read());
    if (found !== null) return found;
    await Bun.sleep(POLL_MS);
  }
  return null;
}

/**
 * Whether Claude Code's own input box holds a draft, read as the chat's sends read it (core/composer.ts
 * claudeBoxReads): an empty box at once, else again with the viewport's colors where they show the
 * live screen, so a grey suggestion is no draft.
 */
async function claudeBoxHoldsDraft(paneId: string): Promise<boolean> {
  const before = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (!claudeInputDraft(before, null)) return false;
  const scrollBefore = await paneScrollInfo(paneId);
  const colors = (await paneRead({ paneId, source: "visible", format: "ansi" })).text;
  const scrollAfter = await paneScrollInfo(paneId);
  const live = (await paneRead({ paneId, source: "detection", format: "text" })).text;
  return claudeInputDraft(live, viewportShowsLive(scrollBefore, scrollAfter, colors, before, live) ? colors : null);
}

/**
 * Whether the screen shows Claude Code after Restore conversation for `message` (recorded at 40 and 120
 * columns, 2.1.304): no rewind panel left, and the message back in its input box.
 */
export function restoredOnScreen(screen: string, message: string): boolean {
  if (parseClaudeRewindConfirm(screen) !== null || parseClaudeRewindList(screen) !== null) return false;
  const box = claudeInputBoxContent(screen);
  return box !== null && normalizeText(box.replace(/^❯\s*/, "")) === normalizeText(message);
}

/**
 * Restore conversation was answered on the rewind card: once Claude Code shows it done, the chat
 * ends before that message and the message in Claude's box is the chat's own again, both tied to
 * the pane's one Claude process (conversation.ts rewindClaudeTranscript, claudeRestoredOwned), so the
 * composer offers it and the next send empties the box first. Nothing is kept when the screen does not show the restore within STEP_MS.
 */
export async function followClaudeRestore(paneId: string, parsed: ParsedPrompt, stepMs = STEP_MS): Promise<void> {
  if (parsed.menuLabels.join("\n") !== CLAUDE_REWIND_CHOICES.join("\n") || !parsed.body) return;
  const message = parsed.body.split("\n")[0]!;
  const walked = asked.get(paneId);
  asked.delete(paneId);
  // a dialog the chat did not walk (opened in the terminal, or the list's own card): which copy of a
  // repeated message was picked is not known, so only a message's one copy is kept
  const later = walked && normalizeText(walked.text) === message ? walked.later : null;
  const read = async () => (await paneRead({ paneId, source: "detection", format: "text" })).text;
  if (await waitFor({ read }, (screen) => restoredOnScreen(screen, message) ? true : null, stepMs) === null) return;
  try {
    const cut = await rewindClaudeTranscript(paneId, message, later);
    // the chat's sends after the restored message went with it: their outcomes would claim evidence no longer there
    if (cut?.at != null) forgetChatSendsAfter(paneId, cut.at);
  } catch (error) {
    console.error(`rewind: the chat could not follow pane ${paneId}'s restore: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const cursorOf = (list: ClaudeRewindList): string => list.rows[list.cursor]!.label;

/**
 * From a confirm step back to the list, the cursor on `label` again: ↓ one key at a time, each sent
 * once the screen shows the last one landed on the same message's step, and Enter only once "Never
 * mind" is shown selected. null: a key moved something else (or nothing within `stepMs`); no further
 * key is sent.
 */
async function backToList(io: RewindIo, confirm: ClaudeRewindConfirm, label: string, stepMs: number): Promise<ClaudeRewindList | null> {
  const never = CLAUDE_REWIND_CHOICES.length - 1;
  for (let shown = confirm; shown.selected !== never;) {
    if (shown.selected > never) return null;
    const next = shown.selected + 1;
    await io.keys([KEY.down]);
    const moved = await waitFor(io, (screen) => {
      const step = parseClaudeRewindConfirm(screen);
      return step !== null && step.message === confirm.message && step.selected === next ? step : null;
    }, stepMs);
    if (moved === null) return null;
    shown = moved;
  }
  await io.keys([KEY.enter]);
  return await waitFor(io, (screen) => {
    const shown = parseClaudeRewindList(screen);
    return shown !== null && cursorOf(shown) === label ? shown : null;
  }, stepMs);
}
/** where the list stands: the row under the cursor and how much lies above it */
const placeOf = (list: ClaudeRewindList): string => `${list.above}\0${list.cursor}\0${list.rows.map((row) => row.label).join("\n")}`;

/**
 * Opens Claude Code's /rewind and walks its list up to the message `text`, `later` other messages with
 * the same words being newer ones, then opens that message's confirm step. "shown": the step is on
 * screen, for the user to answer from its card. "not_found": the list holds no such message and was
 * closed again. "changed": the dialog did not show what a key should have done; nothing more is sent.
 */
export async function walkClaudeRewind(io: RewindIo, text: string, later: number, stepMs = STEP_MS): Promise<RewindWalk> {
  await io.command("/rewind");
  let list = await waitFor(io, parseClaudeRewindList, stepMs);
  if (list === null) return "changed";
  let skip = later;
  for (let rows = 0; rows < MAX_ROWS; rows += 1) {
    const label = cursorOf(list);
    if (label !== "(current)" && rowMatches(label, text)) {
      // a whole row is this message; a row cut short may be another one that starts the same, so only
      // its confirm step's quote counts it as one of the newer copies
      if (skip > 0 && normalizeText(label) === normalizeText(text)) skip -= 1;
      else {
        await io.keys([KEY.enter]);
        const confirm = await waitFor(io, parseClaudeRewindConfirm, stepMs);
        if (confirm === null) return "changed";
        const same = quoteMatches(confirm, text);
        if (same && skip === 0) return "shown";
        if (same) skip -= 1;
        // a newer copy, or another message the cut row reads the same for: back to the list, on the same row
        const back = await backToList(io, confirm, label, stepMs);
        if (back === null) return "changed";
        list = back;
      }
    }
    // the first message: nothing above it
    if (list.cursor === 0 && list.above === 0) {
      await io.keys([KEY.escape]);
      return "not_found";
    }
    const before = placeOf(list);
    await io.keys([KEY.up]);
    const moved = await waitFor(io, (screen) => {
      const shown = parseClaudeRewindList(screen);
      return shown !== null && placeOf(shown) !== before ? shown : null;
    }, stepMs);
    if (moved === null) return "changed";
    list = moved;
  }
  return "changed";
}

/**
 * POST /api/pane/rewind `{ pane_id, text, later? }`. Refused while the agent works or its own input
 * box holds a draft (the browser checks its composer too). A watching device never reaches here: the
 * access gate refuses its mutations.
 */
export async function handleRewindRequest(request: Request, serialize: <T>(paneId: string, task: () => Promise<T>) => Promise<T>): Promise<Response> {
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
  const payload = await readJsonObject<{ pane_id?: unknown; text?: unknown; later?: unknown }>(request);
  if (payload instanceof Response) return payload;
  if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
  if (typeof payload.text !== "string" || !payload.text.trim()) return badRequest("missing_text", "text is required");
  if (payload.later !== undefined && !isCount(payload.later)) return badRequest("invalid_later", "later must be a non-negative integer");
  const paneId = payload.pane_id;
  const text = payload.text;
  const later = payload.later ?? 0;
  try {
    const gone = (): boolean => request.signal.aborted;
    return await serialize(paneId, async () => {
      // the rewind waited its turn in the pane's input order: a requester gone meanwhile gets nothing typed
      if (gone()) return conflictResponse("requester_gone", "The rewind was asked by a connection that is gone");
      const { agent, pane } = await paneContext(paneId);
      if (agent !== "claude" && !UNREAD_INPUT.has(agent ?? "")) return badRequest("rewind_unsupported", "this agent has no rewind from Chat");
      if (pane.agent_status !== "idle" && pane.agent_status !== "done") return conflictResponse("agent_busy", "The agent is not waiting for a message; rewind once it is");
      // its input box is read by nothing here: it cannot be known empty, and /rewind typed over a draft would join it
      if (agent !== "claude") return conflictResponse("input_draft", "The agent's input box cannot be read here to be empty; rewind from the terminal");
      // herdr reports Claude Code idle while one of its dialogs is up (this rewind's own confirm step, from
      // any device, or one opened in the terminal), and a dialog shows no input box: the prompt's Enter
      // would take the choice under its cursor. One rewind per pane: the next waits until its card is
      // answered or dismissed.
      const shown = (await paneRead({ paneId, source: "detection", format: "text" })).text;
      if (claudeInputBoxContent(shown) === null || parseInteractivePrompt("claude", shown) !== null) {
        return conflictResponse("dialog_open", "Claude Code is showing a dialog; answer or close it first");
      }
      if (await claudeBoxHoldsDraft(paneId)) return conflictResponse("input_draft", "Claude Code's input box holds a draft; send or clear it first");
      // a disconnect mid-walk stops the keys after it
      const walked = gone() ? "changed" : await walkClaudeRewind({
        read: async () => (await paneRead({ paneId, source: "detection", format: "text" })).text,
        keys: async (keys) => { if (gone()) throw new RequesterGone(); await paneSendKeys(paneId, keys); },
        command: async (command) => { if (gone()) throw new RequesterGone(); await agentPrompt(paneId, command); },
      }, text, later).catch((error: unknown) => { if (error instanceof RequesterGone) return "changed" as const; throw error; });
      if (walked === "not_found") return conflictResponse("rewind_not_found", "Claude Code's rewind list does not hold this message");
      if (walked === "changed") return conflictResponse("prompt_changed", "Claude Code's rewind dialog did not show what was expected; finish it in the terminal");
      asked.set(paneId, { text, later });
      if (asked.size > 128) asked.delete(asked.keys().next().value!);
      return jsonResponse({ ok: true, outcome: "interaction-required" } satisfies PaneRewindResponse);
    });
  } catch (error) {
    return errorResponse(error);
  }
}
