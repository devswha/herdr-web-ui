/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
}

export const EMPTY_DRAFT: InputDraft = { text: "" };

const MAX_DRAFT_CHARS = 1024;

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/**
 * Folds one onData chunk into the draft: printable text accumulates. Anything else is left
 * out and not told: Enter, arrows and bracketed paste frames contain controls, and so do the
 * answers xterm gives a program by itself (cursor position, focus, mouse), which no one typed.
 */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  if (!isPrintableChar(data) || draft.text.length + data.length > MAX_DRAFT_CHARS) return draft;
  return { text: draft.text + data };
}

export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0;
}
