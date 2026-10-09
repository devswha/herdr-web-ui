import type { SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions } from "./actions.ts";

export const HERDR_WEB_ACTIONS = [
  "help", "settings", "new_workspace", "new_tab", "workspace_picker", "goto", "toggle_sidebar",
  "previous_tab", "next_tab", "switch_tab", "previous_workspace", "next_workspace", "switch_workspace",
  "previous_agent", "next_agent", "focus_agent", "cycle_pane_next", "cycle_pane_previous",
] as const;
export type HerdrWebAction = (typeof HERDR_WEB_ACTIONS)[number];
export function isHerdrWebAction(action: string): action is HerdrWebAction {
  return HERDR_WEB_ACTIONS.some((candidate) => candidate === action);
}
export interface KeyAction {
  readonly action: HerdrWebAction;
  readonly index: number | null;
}
export type NavSnapshot = {
  readonly workspaces: readonly Pick<SessionSnapshot["workspaces"][number], "workspace_id" | "number" | "active_tab_id">[];
  readonly tabs: readonly Pick<SessionSnapshot["tabs"][number], "tab_id" | "workspace_id" | "number">[];
  readonly panes: readonly Pick<SessionSnapshot["panes"][number], "pane_id" | "tab_id" | "workspace_id">[];
  readonly layouts: readonly {
    readonly tab_id: string;
    readonly focused_pane_id: string;
    readonly panes: readonly { readonly pane_id: string; readonly rect: { readonly x: number; readonly y: number } }[];
  }[];
  readonly agents: readonly { readonly pane_id: string }[];
};

function tabPane(snapshot: NavSnapshot, tabId: string): string | null {
  const panes = snapshot.panes.filter((pane) => pane.tab_id === tabId);
  const focused = snapshot.layouts.find((layout) => layout.tab_id === tabId)?.focused_pane_id;
  return panes.find((pane) => pane.pane_id === focused)?.pane_id ?? panes[0]?.pane_id ?? null;
}

/** All navigation is browser selection inside this PC's snapshot, never global Herdr focus. */
export function keyTarget(snapshot: NavSnapshot, paneId: string, target: KeyAction): string | null {
  const pane = snapshot.panes.find((item) => item.pane_id === paneId);
  if (!pane) return null;
  let order: (string | null)[];
  let at: number;
  switch (target.action) {
    case "previous_tab": case "next_tab": case "switch_tab": {
      const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === pane.workspace_id).sort((a, b) => a.number - b.number);
      order = tabs.map((tab) => tabPane(snapshot, tab.tab_id));
      at = tabs.findIndex((tab) => tab.tab_id === pane.tab_id);
      break;
    }
    case "previous_workspace": case "next_workspace": case "switch_workspace": {
      const workspaces = [...snapshot.workspaces].sort((a, b) => a.number - b.number);
      order = workspaces.map((workspace) => tabPane(snapshot, workspace.active_tab_id));
      at = workspaces.findIndex((workspace) => workspace.workspace_id === pane.workspace_id);
      break;
    }
    case "previous_agent": case "next_agent": case "focus_agent":
      order = snapshot.agents.filter((agent) => snapshot.panes.some((item) => item.pane_id === agent.pane_id)).map((agent) => agent.pane_id);
      at = order.indexOf(paneId);
      break;
    case "cycle_pane_next": case "cycle_pane_previous":
      order = [...(snapshot.layouts.find((layout) => layout.tab_id === pane.tab_id)?.panes ?? [])]
        .filter((item) => snapshot.panes.some((candidate) => candidate.pane_id === item.pane_id && candidate.tab_id === pane.tab_id))
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((item) => item.pane_id);
      at = order.indexOf(paneId);
      break;
    default: return null;
  }
  if (target.action === "switch_tab" || target.action === "switch_workspace" || target.action === "focus_agent") {
    return target.index === null ? null : order[target.index - 1] ?? null;
  }
  const backwards = target.action.startsWith("previous_") || target.action === "cycle_pane_previous";
  if (order.length === 0) return null;
  if (at < 0) return order[backwards ? order.length - 1 : 0] ?? null;
  return order[(at + (backwards ? -1 : 1) + order.length) % order.length] ?? null;
}

export function runHerdrAction(target: KeyAction, actions: AppActions, selection: { snapshot: NavSnapshot; paneId: string }): void {
  switch (target.action) {
    case "help": case "workspace_picker": case "goto": actions.openPalette(); return;
    case "settings": actions.openSettings(); return;
    case "new_workspace": actions.openNewSession(); return;
    case "new_tab": actions.openNewTab(); return;
    case "toggle_sidebar": actions.toggleSidebar(); return;
    default: {
      const paneId = keyTarget(selection.snapshot, selection.paneId, target);
      if (paneId !== null) actions.selectPane(paneId);
    }
  }
}
