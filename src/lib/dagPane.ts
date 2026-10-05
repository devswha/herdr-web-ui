import type { PaneInfo } from "../../shared/protocol.ts";

/**
 * A pane omo-herdr-dag opened beside an OmO pane to draw its workflow in the TUI. Told the way
 * the plugin finds its own panes: the label it gives the pane (`DAG · <session>`) or the title
 * its viewer sets (`OmO DAG`).
 */
export function isDagViewerPane(pane: PaneInfo): boolean {
  return [pane.label, pane.terminal_title, pane.terminal_title_stripped]
    .some((name) => typeof name === "string" && (name.startsWith("DAG · ") || name === "OmO DAG"));
}

/**
 * The panes the sidebar and the tab strip show: a DAG viewer is left out while its tab has
 * another pane (the OmO it draws, whose chat already lists the workflow), so it neither adds a
 * tab strip nor a pane to pick. It stays when it is the pane open (`keep`) or all its tab has.
 */
export function rosterPanes<T extends PaneInfo>(panes: readonly T[], keep?: string | null): T[] {
  return panes.filter((pane) => pane.pane_id === keep || !isDagViewerPane(pane)
    || !panes.some((other) => other.tab_id === pane.tab_id && !isDagViewerPane(other)));
}
