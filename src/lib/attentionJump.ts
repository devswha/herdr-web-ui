/**
 * The next agent that waits for a person, from the keyboard (Mod+Shift+A) or the palette: the
 * Agents list's rows in the order it draws them (lib/agentRoster.ts), the blocked ones first, then
 * the finishes nobody has looked at yet, cycled from the selection and round again. The status is
 * the one the row's badge draws (lib/sidebarActivity.tsx), so a finish read in any browser of this
 * server drops out, and a PC that is not connected has nothing to go to, whatever its saved roster
 * says. A row is its PC and its pane. What comes of it is this browser's selection alone: herdr's
 * focus, its TUI and every other device stay where they are.
 */
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import type { AgentRow } from "./agentRoster.ts";

export interface AttentionTarget { machineId: string; paneId: string }

/** `SidebarActivity.status`: what a row's badge says of its pane, the finishes looked at drawn as ready */
export type AttentionStatus = (machineId: string, pane: Pick<HerdrPane, "pane_id" | "agent_status" | "background_wait" | "finish_id">) => AgentStatus | undefined;

/**
 * The rows wanted, in the list's order within each class: every blocked agent of a connected PC,
 * then every finish not looked at yet. Nothing else is attention: ready, running, a turn waiting on
 * its background work, and the unknown states stay out, as do the rows of a PC away.
 */
export function attentionCandidates(roster: readonly AgentRow[], status: AttentionStatus): AttentionTarget[] {
  const blocked: AttentionTarget[] = [];
  const unseen: AttentionTarget[] = [];
  for (const { machine, entry } of roster) {
    if (machine.state !== "connected") continue;
    const shown = status(machine.id, entry.pane);
    if (shown !== "blocked" && shown !== "done") continue;
    (shown === "blocked" ? blocked : unseen).push({ machineId: machine.id, paneId: entry.pane.pane_id });
  }
  return [...blocked, ...unseen];
}

/**
 * The candidate after the selection, round to the first after the last; the first when the
 * selection is none of them; the selection itself when it is the only one; null without any.
 */
export function nextAttentionTarget(candidates: readonly AttentionTarget[], current: { machineId: string; paneId: string | null }): AttentionTarget | null {
  if (candidates.length === 0) return null;
  const key = current.paneId === null ? null : paneStorageId(current.machineId, current.paneId);
  const at = key === null ? -1 : candidates.findIndex((candidate) => paneStorageId(candidate.machineId, candidate.paneId) === key);
  return candidates[(at + 1) % candidates.length]!;
}
