import type { Machine, PaneTarget } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { DockNode } from "./dock-layout.ts";

/** Cached offline rosters do not establish that a session is still running. */
export function runningTargets(machines: readonly Machine[]): PaneTarget[] {
  return machines.flatMap((machine) => {
    if (machine.state !== "connected" || !machine.snapshot) return [];
    return machine.snapshot.panes
      .filter((pane: HerdrPane) => !pane.restore_error
        && (pane.agent_status === "working" || (pane.background_tasks ?? 0) > 0))
      .map((pane) => ({ machine_id: machine.id, pane_id: pane.pane_id }));
  });
}

/** Every live session belongs in the overview, regardless of its agent status. */
export function allSessionTargets(machines: readonly Machine[]): PaneTarget[] {
  return machines.flatMap((machine) => {
    if (machine.state !== "connected" || !machine.snapshot) return [];
    return machine.snapshot.panes
      .filter((pane) => !pane.restore_error)
      .map((pane) => ({ machine_id: machine.id, pane_id: pane.pane_id }));
  });
}

export type LayoutPreset = "auto" | "2-columns" | "3-columns" | "4-columns" | "2x2" | "3x2";

/** Presets rearrange every target; overflow adds splits instead of hiding sessions. */
export function runningLayout(targets: readonly PaneTarget[], preset: LayoutPreset = "auto"): DockNode | null {
  if (!targets.length) return null;
  let split = 0;
  const join = (nodes: readonly DockNode[], direction: "right" | "down"): DockNode => {
    const first = nodes[0];
    if (!first) throw new Error("A dock column must contain a view");
    if (nodes.length === 1) return first;
    const middle = Math.ceil(nodes.length / 2);
    return {
      kind: "split", id: `running-${split++}`, direction, ratio: middle / nodes.length,
      first: join(nodes.slice(0, middle), direction),
      second: join(nodes.slice(middle), direction),
    };
  };
  const columnLimit = { auto: 4, "2-columns": 2, "3-columns": 3, "4-columns": 4, "2x2": 2, "3x2": 3 }[preset];
  const columns = Math.min(columnLimit, targets.length);
  const grid = preset === "2x2" || preset === "3x2";
  const groupCount = grid ? Math.ceil(targets.length / columns) : columns;
  const groups: DockNode[] = [];
  let offset = 0;
  for (let group = 0; group < groupCount; group++) {
    const count = grid ? Math.min(columns, targets.length - offset)
      : Math.ceil((targets.length - offset) / (groupCount - group));
    groups.push(join(targets.slice(offset, offset + count).map((target) => ({ kind: "pane", target })), grid ? "right" : "down"));
    offset += count;
  }
  return join(groups, grid ? "down" : "right");
}
