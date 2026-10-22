/**
 * A Space held in the chat's empty box, sent to Claude Code as a terminal sends it (Settings → Voice →
 * Hold Space for Claude Code voice). A terminal has no key release: Claude Code tells a hold by the
 * key's repeats, and the end of them is the release. So the first press waits ("pending"); a repeat
 * sends it and itself, and every later repeat itself; a release with no repeat was a tap.
 */
export type SpaceHold = "idle" | "pending" | "held";

/** A Space keydown in the empty box: the next state and how many spaces go to the pane. */
export function spaceHoldDown(state: SpaceHold, repeat: boolean): { state: SpaceHold; send: number } {
  if (!repeat) return { state: "pending", send: 0 };
  return { state: "held", send: state === "held" ? 1 : 2 };
}

/** A Space release: idle again, and a tap when no repeat came, which types a space in the box. */
export function spaceHoldUp(state: SpaceHold): { state: "idle"; tap: boolean } {
  return { state: "idle", tap: state === "pending" };
}
