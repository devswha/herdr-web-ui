import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * The greeting of an empty chat: one line over the composer, "What should {agent} do in
 * {folder}?". It is offered only where the conversation is known to hold nothing yet, never
 * where it could not be read, is still loading, or belongs to no agent.
 */

export interface BlankChat {
  /** the first read has answered */
  loaded: boolean;
  /** the last read failed */
  failed: boolean;
  /** the agent's own transcript, not the terminal's scrollback in its place */
  transcript: boolean;
  /** turns on the page and the pages above it */
  turns: number;
  /** pages above the newest were not read yet: the conversation holds more than this page shows */
  older: boolean;
  /** turns a /tree left behind: they are listed where the conversation would start */
  abandoned: number;
  /** a question, approval or menu waits in the chat */
  prompt: boolean;
  agent: string | null;
}

/** A conversation read in full that holds nothing: the only chat a greeting may stand in. */
export function chatIsBlank(chat: BlankChat): boolean {
  return chat.loaded && !chat.failed && chat.transcript && chat.agent !== null
    && chat.turns === 0 && !chat.older && chat.abandoned === 0 && !chat.prompt;
}

/** What one answered read of a pane's conversation says; null where nothing is known (loading, a failed read, the chat not shown). */
export interface ChatRead {
  blank: boolean;
  /** turns it holds, the ones a /tree left behind included */
  turns: number;
  history: string | undefined;
}

/** What is remembered of a pane's chat between its reads, whether the chat is shown or not. */
export interface GreetingMemory {
  /** the last read found the conversation blank */
  blank: boolean;
  /** the history the last answered read was of; null before any */
  history: string | null;
  /** a message went out and the conversation has shown neither a turn nor a new history since */
  sent: boolean;
}

export const NO_MEMORY: GreetingMemory = { blank: false, history: null, sent: false };

/**
 * A read came in. Nothing known (the chat is loading, its read failed, or it left the screen) is
 * not blank, and it forgets no message: only a turn or another history ends what a send began.
 * A read that names no history (the scrollback standing in) is of the one already held.
 */
export function afterRead(memory: GreetingMemory, read: ChatRead | null): GreetingMemory {
  if (read === null) return memory.blank ? { ...memory, blank: false } : memory;
  const history = read.history ?? memory.history ?? "";
  const moved = memory.history !== null && memory.history !== history;
  const sent = memory.sent && read.turns === 0 && !moved;
  return memory.blank === read.blank && memory.history === history && memory.sent === sent ? memory : { blank: read.blank, history, sent };
}

/** A message went out from the composer, read or not yet. */
export function afterSend(memory: GreetingMemory): GreetingMemory {
  return memory.sent ? memory : { ...memory, sent: true };
}

/** That message did not go out after all: nothing was typed into the pane. */
export function afterUnsent(memory: GreetingMemory): GreetingMemory {
  return memory.sent ? { ...memory, sent: false } : memory;
}

// Held outside any component: PaneTerminal is mounted again for each PC (App.tsx), and a look at
// another PC's pane must not bring the greeting back. Keyed by paneStorageId(machineId, paneId).
const remembered = new Map<string, GreetingMemory>();

export function greetingMemory(owner: string): GreetingMemory {
  return remembered.get(owner) ?? NO_MEMORY;
}

export function rememberGreeting(owner: string, memory: GreetingMemory): void {
  if (memory === NO_MEMORY) remembered.delete(owner);
  else remembered.set(owner, memory);
}

export interface GreetingState {
  memory: GreetingMemory;
  agentStatus: AgentStatus | undefined;
  /** messages held for this pane: their list sits where the greeting would */
  queued: number;
  folder: string;
}

/**
 * Whether the greeting shows. A message sent takes it away at once, before the transcript
 * holds the turn; an agent already at work or asking is not asked what it should do.
 */
export function showsGreeting(state: GreetingState): boolean {
  return state.memory.blank && !state.memory.sent
    && state.agentStatus !== "working" && state.agentStatus !== "blocked"
    && state.queued === 0 && state.folder !== "";
}

/**
 * The folder a path ends in: its last segment, the root itself for a root, "" for no path.
 * A backslash separates only in a Windows path (a drive letter or UNC): elsewhere it is a
 * character of the name.
 */
export function greetingFolder(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const separator = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(cwd) ? /[\\/]+/u : /\/+/u;
  const trimmed = cwd.replace(new RegExp(`(?:${separator.source})$`, "u"), "");
  if (trimmed === "") return cwd.charAt(0);
  const parts = trimmed.split(separator);
  return parts[parts.length - 1] ?? "";
}

/**
 * How far (px, zero or negative) the docked composer moves up so that it and the greeting above
 * it sit at the vertical centre of the stack. Zero when the stack is too short to hold both.
 */
export function composerLift(stackHeight: number, composerHeight: number, greetingHeight: number): number {
  const spare = stackHeight - composerHeight - greetingHeight;
  if (!(spare > 0)) return 0;
  return 0 - Math.round(spare / 2);
}

/**
 * Whether the stack holds the composer and the greeting above it. Where it does not (a phone on
 * its side with the keyboard up), the greeting would run out of the pane's top: it stays out.
 */
export function greetingFits(stackHeight: number, composerHeight: number, greetingHeight: number): boolean {
  return stackHeight - composerHeight - greetingHeight >= 0;
}

/**
 * The room (px) over the input card of a lifted composer, where its completion menu opens:
 * from the stack's top to the card's top. `cardOffset` is the card's top within the composer.
 */
export function roomOverComposer(stackHeight: number, composerHeight: number, lift: number, cardOffset: number): number {
  const room = stackHeight - composerHeight + lift + cardOffset;
  return room > 0 ? Math.round(room) : 0;
}
