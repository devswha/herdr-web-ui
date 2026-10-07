/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** text was typed or pasted that the draft had no room for: what is held is not all of it */
  readonly truncated: boolean;
}

export const EMPTY_DRAFT: InputDraft = { text: "", truncated: false };

const MAX_DRAFT_CHARS = 1024;

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/**
 * Folds one onData chunk into the draft: printable text accumulates. A chunk with controls
 * is left out and not told: Enter, arrows and bracketed paste frames contain them, and so do
 * the answers xterm gives a program by itself (cursor position, focus, mouse), which no one
 * typed. Text the draft has no room for is left out whole, never cut in the middle of what
 * was typed, and the draft says so.
 */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  if (!isPrintableChar(data)) return draft;
  if (draft.text.length + data.length > MAX_DRAFT_CHARS) return draft.truncated ? draft : { ...draft, truncated: true };
  return { ...draft, text: draft.text + data };
}

/** Nothing held and nothing to tell. A draft that only lost text is not empty: its loss is still to be told. */
export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && !draft.truncated;
}
