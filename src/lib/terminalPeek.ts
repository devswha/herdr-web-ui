/**
 * The terminal peek (DESIGN.md, the terminal-command handoff): a command that runs in the terminal,
 * sent from Chat, shows the pane's own terminal over the chat's transcript. The chat stays mounted
 * under it, so its place and its reads go on; the composer stays too, inert. It is this browser's
 * state only: the pane's saved lens and the address keep saying Chat, nothing is attached anew (the
 * grid under the chat is the attached one), and herdr's focus never moves.
 *
 * The chat comes back by hand (Back to Chat, the header's Chat, Mod+Shift+J, a phone's Back), and
 * for Claude Code on its own: Claude records a `local_command` answer when one of its panels
 * closes ("Settings dialog dismissed"), and the chat reads it as a local-command notice. Only a
 * notice written after the send's own outcome was created counts; both times are the PC's clock,
 * never this browser's.
 */

import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import type { SplitSlot } from "./split.ts";

/** What PaneTerminal asks App to show; App adds where (its slot, the PC and the pane). */
export interface PeekRequest {
  /** the command as the head names it, its trigger included (`/usage`) */
  command: string;
  /** the text that was sent, which finds the send's own outcome; null: opened by hand */
  text: string | null;
  /** the outcome ids the chat had read when the text left; null: none read yet, or opened by hand */
  knownOutcomeIds: readonly string[] | null;
  /** the chat comes back by itself once the agent records that the command's screen closed */
  auto: boolean;
}

export interface TerminalPeek extends PeekRequest {
  /** the split half it opened in: the other half never shows it */
  slot: SplitSlot;
  machineId: string;
  paneId: string;
}

/**
 * The Claude Code commands whose screen, closed and only then, makes Claude record a
 * `local_command` answer the chat reads as a local-command notice (recorded with Claude Code
 * 2.1.306, each sent bare): "Settings dialog dismissed" for /usage, /cost and /status, "<X> dialog
 * dismissed" for /stats, /help, /config, /permissions, /hooks, /skills, /workflows and /passes,
 * "Theme picker dismissed", "Resume cancelled", "Power-ups closed" and "Fast mode ON/OFF".
 *
 * An allow list, so every other command (a custom or unknown one included) comes back by hand:
 * /diff records when its panel opens, which would end the peek at once; /export, /plugin, /mobile,
 * /autocompact, /add-dir, /mcp and /scroll-speed record entries the chat does not show; /sandbox
 * and /tasks record nothing; /memory hands a picked file to the editor. Claude's fullscreen renderer
 * records nothing for most of these, and a session records nothing before its first message: the
 * peek never waits on the record, it only comes back sooner when there is one.
 */
export const CLAUDE_AUTO_RETURN: ReadonlySet<string> = new Set([
  "usage", "cost", "status", "stats", "help", "config", "theme", "permissions", "hooks", "skills", "workflows", "passes",
  "resume", "powerup", "fast",
]);

/** The peek a pane shows: App's one peek, when it is this half's, this PC's and this pane's. */
export function peekFor(peek: TerminalPeek | null, slot: SplitSlot, machineId: string, paneId: string | null): TerminalPeek | null {
  return peek !== null && peek.slot === slot && peek.machineId === machineId && peek.paneId === paneId ? peek : null;
}

/**
 * What the lens and the peek leave mounted and covered: the chat (its transcript, composer, queue
 * and prompt dock) is mounted whenever the lens is Chat, and covers the grid only while no peek
 * shows it. Everything that sizes, focuses or types into the grid follows `gridCovered`.
 */
export function paneLensFlags(view: PaneView, peek: TerminalPeek | null): { chatMounted: boolean; gridCovered: boolean } {
  const chatMounted = view === "chat";
  return { chatMounted, gridCovered: chatMounted && peek === null };
}

/**
 * Whether the chat comes back by itself after `text`, which invokes `command` (its name, no
 * trigger), is sent to `agent`: Claude Code alone, and only a bare command the recording covers
 * (`/fast on` sets the mode with no screen to close, and no other form was recorded).
 */
export function autoReturnArmed(agent: string | null, text: string, command: string): boolean {
  return agent === "claude" && /^\S+$/u.test(text.trim()) && CLAUDE_AUTO_RETURN.has(command.toLocaleLowerCase());
}

/**
 * The send's own outcome: the newest one with the sent text that the chat had not read when the
 * text left (the bridge lists them oldest first). An older identical send was read already and is
 * passed over; so is one sent just before that no read had listed yet, whose earlier close notice
 * would otherwise end this peek at once. A later identical send (another device's) is taken
 * instead, which only leaves the return to the reader. None listed yet is null.
 */
export function sentOutcome(peek: PeekRequest, outcomes: readonly CommandOutcome[]): CommandOutcome | null {
  if (peek.text === null || peek.knownOutcomeIds === null) return null;
  const known = new Set(peek.knownOutcomeIds);
  const text = peek.text.trim();
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    const outcome = outcomes[index]!;
    if (!known.has(outcome.id) && outcome.text.trim() === text) return outcome;
  }
  return null;
}

/**
 * Whether the command's screen has closed: Claude Code wrote a local-command notice after the
 * send's outcome was created (`sentAt`, that outcome's `created_at`). No other agent says so in
 * its transcript; their peek stays until the reader leaves it.
 */
export function commandScreenClosed(peek: PeekRequest, agent: string | null, sentAt: string | null, turns: readonly ConversationTurn[]): boolean {
  if (!peek.auto || agent !== "claude" || sentAt === null) return false;
  const sent = Date.parse(sentAt);
  if (!Number.isFinite(sent)) return false;
  return turns.some((turn) => turn.role === "user" && turn.ts !== null && Date.parse(turn.ts) > sent
    && turn.parts.some((part) => part.kind === "notice" && part.source === "local-command"));
}

/** What keeps the chat from coming back by itself: the return is then left to the reader. */
export interface ReturnBlockers {
  /** terminal input held for review (typed while the pane could not take it) */
  heldDraft: boolean;
  /** the terminal's find bar is open */
  findOpen: boolean;
  /** an IME composition is under way in the grid or in its input line (the return would unmount the line) */
  composing: boolean;
}

export function returnBlocked(blockers: ReturnBlockers): boolean {
  return blockers.heldDraft || blockers.findOpen || blockers.composing;
}
