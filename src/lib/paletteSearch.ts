import type { HerdrPane, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { paneStatus, type KnownStatus } from "./status.ts";

export type PaletteStatusFilter = "all" | Exclude<KnownStatus, "unknown">;

export const STATUS_FILTERS: readonly PaletteStatusFilter[] = ["all", "blocked", "working", "idle", "done", "waiting"];

/**
 * herdr's picker keys as they are: b blocked, w working, i idle, d done, a all. The palette
 * listens for them only while the focus is outside its search field, so a query never loses a
 * letter to them. BG has no key in herdr and gets none here.
 */
export const FILTER_KEYS: Readonly<Record<string, PaletteStatusFilter>> = { a: "all", b: "blocked", w: "working", i: "idle", d: "done" };

export interface PaletteQuery {
  actionsOnly: boolean;
  text: string;
}

/** A query that starts with `>` searches the actions alone, as T3 Code's palette reads that prefix. */
export function parseQuery(query: string): PaletteQuery {
  const trimmed = query.trimStart();
  if (trimmed.startsWith(">")) return { actionsOnly: true, text: trimmed.slice(1).trim() };
  return { actionsOnly: false, text: query.trim() };
}

export function filterPanesByStatus(panes: readonly HerdrPane[], filter: PaletteStatusFilter): HerdrPane[] {
  if (filter === "all") return [...panes];
  return panes.filter((pane) => paneStatus(pane) === filter);
}

/** How many panes each chip stands for, counted over the whole roster: a query does not change them. */
export function statusCounts(panes: readonly HerdrPane[]): Record<PaletteStatusFilter, number> {
  const counts: Record<PaletteStatusFilter, number> = { all: panes.length, blocked: 0, working: 0, idle: 0, done: 0, waiting: 0 };
  for (const pane of panes) {
    const status = paneStatus(pane);
    if (status !== "unknown") counts[status] += 1;
  }
  return counts;
}

export interface PaletteSearchContext {
  tabs?: readonly TabInfo[];
  /** a linked worktree's branch per workspace id, as useWorktreeBranches reads the inventory */
  branches?: ReadonlyMap<string, { branch: string | null }>;
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

function searchableText(pane: HerdrPane, workspaceLabel: string, tabLabel: string, branch: string): string[] {
  return [
    pane.label ?? "",
    pane.title ?? "",
    pane.terminal_title_stripped ?? "",
    pane.terminal_title ?? "",
    pane.cwd ?? "",
    pane.foreground_cwd ?? "",
    workspaceLabel,
    tabLabel,
    branch,
    pane.agent ?? "",
    pane.display_agent ?? "",
  ];
}

/** Fuzzy pane search across everything visible in a palette row. Ties retain session order. */
export function rankPanes(query: string, panes: readonly HerdrPane[], workspaces: readonly WorkspaceInfo[], context: PaletteSearchContext = {}): HerdrPane[] {
  if (query.trim().length === 0) return [...panes];
  const workspaceLabels = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
  const tabLabels = new Map((context.tabs ?? []).map((tab) => [tab.tab_id, tab.label]));
  return panes
    .map((pane, index) => {
      let score: number | null = null;
      const branch = context.branches?.get(pane.workspace_id)?.branch ?? "";
      for (const candidate of searchableText(pane, workspaceLabels.get(pane.workspace_id) ?? "", tabLabels.get(pane.tab_id) ?? "", branch)) {
        const candidateScore = fuzzyScore(query, candidate);
        if (candidateScore !== null && (score === null || candidateScore > score)) score = candidateScore;
      }
      return { pane, index, score };
    })
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ pane }) => pane);
}

export interface PaletteSection {
  workspaceId: string;
  workspace: WorkspaceInfo | undefined;
  panes: HerdrPane[];
}

/**
 * One section per workspace, as herdr's Goto picker lists its rows. A section stands where its
 * first pane stands in `panes`: in session order for an unsearched list, and best match first for
 * a ranked one, so the top result stays the first row. Rows keep their order inside a section.
 */
export function groupByWorkspace(panes: readonly HerdrPane[], workspaces: readonly WorkspaceInfo[]): PaletteSection[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  const sections = new Map<string, PaletteSection>();
  for (const pane of panes) {
    let section = sections.get(pane.workspace_id);
    if (!section) {
      section = { workspaceId: pane.workspace_id, workspace: byId.get(pane.workspace_id), panes: [] };
      sections.set(pane.workspace_id, section);
    }
    section.panes.push(pane);
  }
  return [...sections.values()];
}

/**
 * The panes the user went to last, newest first, those still in the roster and other than the
 * one open now: an unsearched palette leads with them, before the workspaces.
 */
export function recentPanes(panes: readonly HerdrPane[], recentIds: readonly string[], selectedPaneId: string | null, limit: number): HerdrPane[] {
  const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
  const recent: HerdrPane[] = [];
  for (const id of recentIds) {
    const pane = byId.get(id);
    if (pane && id !== selectedPaneId) recent.push(pane);
    if (recent.length === limit) break;
  }
  return recent;
}
