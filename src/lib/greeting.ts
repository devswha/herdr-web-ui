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
  /** turns a /tree left behind: they are listed where the conversation would start */
  abandoned: number;
  /** a question, approval or menu waits in the chat */
  prompt: boolean;
  agent: string | null;
}

/** A conversation read in full that holds nothing: the only chat a greeting may stand in. */
export function chatIsBlank(chat: BlankChat): boolean {
  return chat.loaded && !chat.failed && chat.transcript && chat.agent !== null
    && chat.turns === 0 && chat.abandoned === 0 && !chat.prompt;
}

export interface GreetingState {
  /** the composer message count when the chat was found blank; null while it is not blank */
  blankAtSent: number | null;
  /** the composer message count now */
  sent: number;
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
  return state.blankAtSent !== null && state.blankAtSent === state.sent
    && state.agentStatus !== "working" && state.agentStatus !== "blocked"
    && state.queued === 0 && state.folder !== "";
}

/** The folder a path ends in: its last segment, the root itself for a root, "" for no path. */
export function greetingFolder(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const trimmed = cwd.replace(/[\\/]+$/u, "");
  if (trimmed === "") return cwd.charAt(0);
  const parts = trimmed.split(/[\\/]/u);
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
