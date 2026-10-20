/**
 * What a user message in Chat offers to go back to it, by the pane's agent. Claude Code's /rewind is
 * walked by the bridge and answered from a card ("card"). grok and agy keep a rewind the chat already
 * follows (server/grok.ts, server/agy.ts), but nothing reads their input box, so nothing may be typed
 * there: the action only opens the terminal for the user to run it ("terminal"). Others: no action.
 */
export type RewindAction = "card" | "terminal" | null;

export function rewindAction(agent: string | null): RewindAction {
  if (agent === "claude") return "card";
  return agent === "grok" || agent === "agy" ? "terminal" : null;
}
