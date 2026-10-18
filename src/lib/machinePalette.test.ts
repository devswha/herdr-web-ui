import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { availableTarget, rankMachinePanes, recentTargets, rememberTarget } from "./machinePalette.ts";

const panes = [
  { pane_id: "p1", workspace_id: "w1", tab_id: "t1", label: "Dashboard", agent_status: "idle" },
  { pane_id: "p2", workspace_id: "w1", tab_id: "t1", label: "Migration", agent_status: "blocked" },
] as HerdrPane[];
const host: Machine = { id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null,
  snapshot: { protocol: 1, version: "test", panes, workspaces: [], tabs: [], agents: [], layouts: [] } as SessionSnapshot };
const t = (key: string) => translate("en", key);
const search = (query: string) => rankMachinePanes(query, [host], "all", new Map(), t);

describe("workstation palette", () => {
  it("searches pane titles and keeps status filters", () => {
    expect(search("Migration").map((entry) => entry.pane.pane_id)).toEqual(["p2"]);
    expect(rankMachinePanes("", [host], "blocked", new Map(), t).map((entry) => entry.pane.pane_id)).toEqual(["p2"]);
    expect(availableTarget([host], { machineId: "local", paneId: "closed" })).toBeNull();
  });
  it("keeps recent panes in order and excludes the selected pane", () => {
    const first = { machineId: "local", paneId: "p1" };
    const second = { machineId: "local", paneId: "p2" };
    const recent = rememberTarget(second, rememberTarget(first, [second]));
    expect(recent).toEqual([second, first]);
    expect(recentTargets(search(""), recent, second, 3).map((entry) => entry.paneId)).toEqual(["p1"]);
  });
});
