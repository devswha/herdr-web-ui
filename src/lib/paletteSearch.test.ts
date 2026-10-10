import { describe, expect, it } from "bun:test";

import type { PaneInfo, WorkspaceInfo, PluginActions } from "../../shared/protocol.ts";
import { offeredPluginActions, rankPanes } from "./paletteSearch.ts";

function pane(paneId: string, fields: Partial<PaneInfo> = {}): PaneInfo {
  return {
    pane_id: paneId,
    workspace_id: "w1",
    tab_id: "t1",
    terminal_id: `term-${paneId}`,
    agent_status: "idle",
    focused: false,
    revision: 1,
    ...fields,
  };
}

const workspaces = [
  { workspace_id: "w1", label: "Frontend", active_tab_id: "t1", agent_status: "idle", focused: false, number: 1, pane_count: 2, tab_count: 1 },
  { workspace_id: "w2", label: "Backend", active_tab_id: "t2", agent_status: "working", focused: false, number: 2, pane_count: 1, tab_count: 1 },
] satisfies WorkspaceInfo[];

const panes = [
  pane("alpha", { label: "Dashboard", cwd: "/work/client", agent: "claude" }),
  pane("beta", { label: "Database migration", cwd: "/work/server", agent: "codex", workspace_id: "w2" }),
  pane("gamma", { title: "Shell", cwd: "/work/frontend-tools" }),
];

describe("rankPanes", () => {
  it("keeps session order for an empty query", () => {
    expect(rankPanes("  ", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("searches title, cwd, workspace and agent metadata", () => {
    expect(rankPanes("migration", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("server", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("backend", panes, workspaces).map((item) => item.pane_id)).toEqual(["beta"]);
    expect(rankPanes("claude", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha"]);
  });

  it("supports ordered fuzzy characters and ranks a direct match first", () => {
    expect(rankPanes("dsh", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha"]);
    expect(rankPanes("front", panes, workspaces).map((item) => item.pane_id)).toEqual(["alpha", "gamma"]);
    expect(rankPanes("zzq", panes, workspaces)).toEqual([]);
  });
});

const plugin = (overrides: Partial<PluginActions>): PluginActions => ({ plugin_id: "example.layout", name: "Layout", version: "0.1.0", description: null, enabled: true, actions: [], ...overrides });
const action = (action_id: string, contexts: string[], title = action_id) => ({ action_id, title, description: null, contexts });
const ids = (offered: ReturnType<typeof offeredPluginActions>) => offered.map(({ plugin: owner, action: entry }) => `${owner.plugin_id}.${entry.action_id}`);

describe("offeredPluginActions", () => {
  const plugins = [
    plugin({ actions: [action("apply", ["workspace"], "Apply layout"), action("anywhere", ["global"]), action("bare", []), action("quote", ["selection"]), action("pane-or-text", ["pane", "selection"])] }),
    plugin({ plugin_id: "example.off", name: "Off", enabled: false, actions: [action("hidden", ["global"])] }),
  ];

  it("offers what applies to the selected pane and leaves out a disabled plugin and a selection-only action", () => {
    expect(ids(offeredPluginActions(plugins, true, ""))).toEqual(["example.layout.apply", "example.layout.anywhere", "example.layout.bare", "example.layout.pane-or-text"]);
  });

  it("offers only an action that needs no place when no pane is selected", () => {
    expect(ids(offeredPluginActions(plugins, false, ""))).toEqual(["example.layout.anywhere", "example.layout.bare"]);
  });

  it("searches the action's title and its plugin's name", () => {
    expect(ids(offeredPluginActions(plugins, true, " APPLY "))).toEqual(["example.layout.apply"]);
    expect(ids(offeredPluginActions(plugins, true, "layout")).length).toBe(4);
    expect(offeredPluginActions(plugins, true, "nothing like it")).toEqual([]);
  });
});
