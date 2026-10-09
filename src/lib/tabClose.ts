import type { PaneInfo } from "../../shared/protocol.ts";
import { knownStatus } from "./status.ts";

/**
 * What a tab close takes besides the tab, which is why it asks first (herdr's ui.confirm_close):
 * the workspace, when it is the workspace's last tab; an agent still at work in it; or, from a
 * surface that stands for one pane of the tab (an agent row), the panes split beside that one.
 * Null closes at once.
 */
export type TabCloseCost = "last" | "busy" | "split" | null;

export function tabCloseCost(
  tabId: string,
  workspaceTabs: number,
  panes: readonly Pick<PaneInfo, "tab_id" | "agent_status">[],
  { split = false }: { split?: boolean } = {},
): TabCloseCost {
  if (workspaceTabs <= 1) return "last";
  const own = panes.filter((pane) => pane.tab_id === tabId);
  if (own.some((pane) => { const status = knownStatus(pane.agent_status); return status === "working" || status === "blocked"; })) return "busy";
  return split && own.length > 1 ? "split" : null;
}
