import type { AgentStatus } from "../../shared/protocol.ts";

/**
 * herdr's only "seen" call is `pane.focus`, which also brings the pane to the front at its
 * terminal: so tell it once per finish, only for a pane the user opened (`key`, else null),
 * in view and reading `done`. Returns whether to tell now and what has been told.
 */
export function seenStep(told: string | null, key: string | null, status: AgentStatus | undefined, inView: boolean): { told: string | null; tell: boolean } {
  if (key === null || status !== "done") return { told: null, tell: false };
  if (!inView || told === key) return { told, tell: false };
  return { told: key, tell: true };
}
