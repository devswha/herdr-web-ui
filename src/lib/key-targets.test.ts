import { describe, expect, it } from "bun:test";
import { keyTarget, runHerdrAction, type NavSnapshot } from "./key-targets.ts";
import type { AppActions } from "./actions.ts";

const snapshot: NavSnapshot = {
  workspaces: [{ workspace_id: "w2", number: 2, active_tab_id: "t3" }, { workspace_id: "w1", number: 1, active_tab_id: "t1" }],
  tabs: [{ tab_id: "t2", workspace_id: "w1", number: 2 }, { tab_id: "t3", workspace_id: "w2", number: 1 }, { tab_id: "t1", workspace_id: "w1", number: 1 }],
  panes: [
    { pane_id: "p1", tab_id: "t1", workspace_id: "w1" }, { pane_id: "p2", tab_id: "t1", workspace_id: "w1" },
    { pane_id: "p3", tab_id: "t2", workspace_id: "w1" }, { pane_id: "p4", tab_id: "t3", workspace_id: "w2" },
  ],
  layouts: [
    { tab_id: "t1", focused_pane_id: "p2", panes: [{ pane_id: "p2", rect: { x: 10, y: 0 } }, { pane_id: "p1", rect: { x: 0, y: 0 } }] },
    { tab_id: "t2", focused_pane_id: "p4", panes: [{ pane_id: "p3", rect: { x: 0, y: 0 } }] },
  ],
  agents: [{ pane_id: "p2" }, { pane_id: "p4" }],
};

describe("PC-local keyboard navigation", () => {
  it("uses sorted tab numbers and never follows another tab's focused pane", () => {
    expect(keyTarget(snapshot, "p1", { action: "next_tab", index: null })).toBe("p3");
    expect(keyTarget(snapshot, "p3", { action: "next_tab", index: null })).toBe("p2");
    expect(keyTarget(snapshot, "p1", { action: "switch_tab", index: 2 })).toBe("p3");
    expect(keyTarget(snapshot, "p1", { action: "switch_tab", index: 9 })).toBeNull();
  });

  it("uses workspace and agent ordering without crossing the supplied PC snapshot", () => {
    expect(keyTarget(snapshot, "p1", { action: "next_workspace", index: null })).toBe("p4");
    expect(keyTarget(snapshot, "p4", { action: "switch_workspace", index: 1 })).toBe("p2");
    expect(keyTarget(snapshot, "p1", { action: "previous_agent", index: null })).toBe("p4");
    expect(keyTarget(snapshot, "p1", { action: "focus_agent", index: 1 })).toBe("p2");
    expect(keyTarget(snapshot, "foreign-pane", { action: "next_tab", index: null })).toBeNull();
  });

  it("cycles only existing panes of the current tab in reading order", () => {
    expect(keyTarget(snapshot, "p1", { action: "cycle_pane_next", index: null })).toBe("p2");
    expect(keyTarget(snapshot, "p2", { action: "cycle_pane_next", index: null })).toBe("p1");
    expect(keyTarget({ ...snapshot, panes: snapshot.panes.filter((pane) => pane.pane_id !== "p2") }, "p1", { action: "cycle_pane_next", index: null })).toBe("p1");
  });

  it("runs existing creation dialogs and selected-PC selection instead of a command RPC", () => {
    const called: string[] = [];
    const actions: AppActions = {
      selectPane: (pane) => { called.push(pane); }, selectAdjacentPane: () => {}, setView: () => {},
      toggleView: () => {}, openNewSession: () => { called.push("workspace-dialog"); },
      openNewTab: () => { called.push("tab-dialog"); }, openPalette: () => {}, openSettings: () => {},
      openAddPc: () => {}, toggleSidebar: () => {}, toggleTheme: () => {}, lock: null,
      enableNotifications: null, refresh: () => {}, openFiles: null,
    };
    runHerdrAction({ action: "new_tab", index: null }, actions, { snapshot, paneId: "p1" });
    runHerdrAction({ action: "new_workspace", index: null }, actions, { snapshot, paneId: "p1" });
    runHerdrAction({ action: "next_workspace", index: null }, actions, { snapshot, paneId: "p1" });
    expect(called).toEqual(["tab-dialog", "workspace-dialog", "p4"]);
  });
});
