import type { PaneInfo, PluginAction, PluginActions, WorkspaceInfo } from "../../shared/protocol.ts";

/** One row of the palette's Plugin actions group. */
export interface OfferedPluginAction {
  plugin: PluginActions;
  action: PluginAction;
}

/**
 * The plugin actions the palette can run now. A disabled plugin's are left out (herdr refuses
 * them), as is one that only applies to selected text, which the web has none of to hand over.
 * Without a selected pane only an action that needs no place is offered: herdr would otherwise
 * run it against its own focus, a pane the user is not looking at here.
 */
export function offeredPluginActions(plugins: readonly PluginActions[], hasPane: boolean, query: string): OfferedPluginAction[] {
  const needle = query.trim().toLocaleLowerCase();
  const offered: OfferedPluginAction[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const action of plugin.actions) {
      const anywhere = action.contexts.length === 0 || action.contexts.includes("global");
      const placed = action.contexts.some((context) => context === "workspace" || context === "tab" || context === "pane");
      if (!anywhere && !(hasPane && placed)) continue;
      if (needle && !action.title.toLocaleLowerCase().includes(needle) && !plugin.name.toLocaleLowerCase().includes(needle)) continue;
      offered.push({ plugin, action });
    }
  }
  return offered;
}

function fuzzyScore(query: string, candidate: string): number | null {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return 0;
  const haystack = candidate.toLocaleLowerCase();
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 1000 - direct * 2 - (haystack.length - needle.length);

  let queryIndex = 0;
  let first = -1;
  let previous = -2;
  let runs = 0;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[queryIndex]) continue;
    if (first < 0) first = index;
    if (index !== previous + 1) runs += 1;
    previous = index;
    queryIndex += 1;
  }
  if (queryIndex !== needle.length) return null;
  return 500 - first * 2 - (previous - first) - runs * 12;
}

function searchableText(pane: PaneInfo, workspaceLabel: string): string[] {
  return [
    pane.label ?? "",
    pane.title ?? "",
    pane.terminal_title_stripped ?? "",
    pane.terminal_title ?? "",
    pane.cwd ?? "",
    pane.foreground_cwd ?? "",
    workspaceLabel,
    pane.agent ?? "",
    pane.display_agent ?? "",
  ];
}

/** Fuzzy pane search across everything visible in a palette row. Ties retain session order. */
export function rankPanes(query: string, panes: readonly PaneInfo[], workspaces: readonly WorkspaceInfo[]): PaneInfo[] {
  if (query.trim().length === 0) return [...panes];
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
  return panes
    .map((pane, index) => {
      let score: number | null = null;
      for (const candidate of searchableText(pane, workspaceLabels.get(pane.workspace_id) ?? "")) {
        const candidateScore = fuzzyScore(query, candidate);
        if (candidateScore !== null && (score === null || candidateScore > score)) score = candidateScore;
      }
      return { pane, index, score };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ pane }) => pane);
}
