/** How the held-message list above the composer shows: its rows, or only its caption. */

/** A phone with too little height for the rows: its keyboard is up, or it lies on its side. */
export const SHORT_PHONE_QUERY = "(max-width: 480px) and (max-height: 600px)";

export interface HeldRowsState {
  /** a prompt card is open in this pane's chat */
  promptOpen: boolean;
  /** SHORT_PHONE_QUERY matches */
  shortPhone: boolean;
  /** the agent is ready: the list asks for the user's own action */
  ready: boolean;
}

/**
 * Whether the rows give their room away and fold into the caption, which is then a disclosure
 * button. A list that asks for an action is never folded: Send now stays in sight.
 */
export function heldRowsFold({ promptOpen, shortPhone, ready }: HeldRowsState): boolean {
  return !ready && (promptOpen || shortPhone);
}

/**
 * Whether the rows are hidden. Folding only hides: the rows stay mounted, and they show while
 * the user opened them or one of them carries an error the user has to read.
 */
export function heldRowsHidden(fold: boolean, opened: boolean, rowError: boolean): boolean {
  return fold && !opened && !rowError;
}

/**
 * Whether the caption says how many messages it stands for: from two on, and for a single one
 * while the caption can be all there is to see.
 */
export function heldCountShown(count: number, fold: boolean): boolean {
  return count > 1 || (fold && count === 1);
}
