/**
 * Where a pane can be moved (the "Move pane to…" menu) and what this browser keeps about a
 * pane under its id, carried over when a move gives the pane a new one.
 */
import { paneStorageId } from "../../shared/machines.ts";
import type { MovePaneDestination, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { composerDrafts, type ComposerDraftStore } from "./composerDraft.ts";
import { tabLabel } from "./tabName.ts";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface MoveTarget {
  id: string;
  kind: "new-tab" | "tab" | "workspace" | "new-workspace";
  label: string;
  destination: MovePaneDestination;
  /** the first of a group: drawn under a hairline */
  divider?: boolean;
}

/**
 * The menu's order: a new tab of the pane's workspace, that workspace's other tabs as the strip
 * orders them, every other workspace (the pane lands in a new tab there) in the sidebar's order,
 * then a workspace of its own. The pane's own tab is left out: herdr would answer same_tab.
 */
export function paneMoveTargets(snapshot: Pick<SessionSnapshot, "tabs" | "workspaces">, pane: Pick<PaneInfo, "workspace_id" | "tab_id">, t: Translate): MoveTarget[] {
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id).sort((a, b) => a.number - b.number);
  const own: MoveTarget[] = [
    { id: "new-tab", kind: "new-tab", label: t("New tab"), destination: { type: "new_tab" } },
    ...tabs.flatMap((tab, index): MoveTarget[] => tab.tab_id === pane.tab_id ? [] : [{ id: `tab:${tab.tab_id}`, kind: "tab", label: tabLabel(tab, t, index + 1), destination: { type: "tab", tab_id: tab.tab_id } }]),
  ];
  const others = snapshot.workspaces
    .filter((workspace) => workspace.workspace_id !== pane.workspace_id)
    .map((workspace, index): MoveTarget => ({ id: `workspace:${workspace.workspace_id}`, kind: "workspace", label: workspace.label, destination: { type: "new_tab", workspace_id: workspace.workspace_id }, divider: index === 0 }));
  return [...own, ...others, { id: "new-workspace", kind: "new-workspace", label: t("New workspace"), destination: { type: "new_workspace" }, divider: true }];
}

type CarriedStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The records this browser keeps per pane that follow it to a new id: the lens it was last
 * viewed in and the two unsent drafts. A held message or a pending send stays under the old id:
 * it names a lease the server gave that pane, which the move does not carry.
 */
export function carryPaneRecords(
  machineId: string,
  previousPaneId: string,
  paneId: string,
  deps: { storage: () => CarriedStorage; drafts: Pick<ComposerDraftStore, "read" | "set"> } = { storage: () => window.localStorage, drafts: composerDrafts },
): void {
  if (previousPaneId === paneId) return;
  const from = paneStorageId(machineId, previousPaneId);
  const to = paneStorageId(machineId, paneId);
  for (const prefix of ["herdr-web-ui:view:", "herdr-web-ui:terminal-draft:"]) {
    try {
      const value = deps.storage().getItem(prefix + from);
      if (value === null) continue;
      deps.storage().setItem(prefix + to, value);
      deps.storage().removeItem(prefix + from);
    } catch { /* storage blocked: the record stays where it was */ }
  }
  const draft = deps.drafts.read(`herdr-web-ui:composer-draft:${from}`);
  if (draft.sending || draft.text === "") return;
  deps.drafts.set(`herdr-web-ui:composer-draft:${to}`, draft.text);
  deps.drafts.set(`herdr-web-ui:composer-draft:${from}`, "");
}
