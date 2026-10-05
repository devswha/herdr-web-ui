import { describe, expect, it } from "bun:test";
import type { PaneInfo } from "../../shared/protocol.ts";
import { isDagViewerPane, rosterPanes } from "./dagPane.ts";

const pane = (id: string, tab: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({ pane_id: id, workspace_id: "w1", tab_id: tab, terminal_id: id, revision: 1, focused: false, agent_status: "idle", ...extra });
const omo = pane("omo", "t1", { agent: "omo" });
const viewer = pane("dag", "t1", { label: "DAG · 01a10998", terminal_title: "OmO DAG" });

describe("isDagViewerPane", () => {
  it("knows the viewer by the label omo-herdr-dag gives it or the title its viewer sets", () => {
    expect(isDagViewerPane(viewer)).toBeTrue();
    expect(isDagViewerPane(pane("p", "t1", { terminal_title_stripped: "OmO DAG" }))).toBeTrue();
    expect(isDagViewerPane(pane("p", "t1", { label: "DAG · 01a10998" }))).toBeTrue();
    expect(isDagViewerPane(omo)).toBeFalse();
    expect(isDagViewerPane(pane("p", "t1", { label: "DAG notes", terminal_title: "OmO DAG viewer" }))).toBeFalse();
  });
});

describe("rosterPanes", () => {
  it("leaves out a viewer beside the pane it draws, so the workspace has one pane", () => {
    expect(rosterPanes([omo, viewer]).map((entry) => entry.pane_id)).toEqual(["omo"]);
  });

  it("keeps the viewer while it is the pane open", () => {
    expect(rosterPanes([omo, viewer], "dag").map((entry) => entry.pane_id)).toEqual(["omo", "dag"]);
  });

  it("keeps a viewer that is all its tab has, so the pane can still be reached and closed", () => {
    const alone = pane("dag2", "t2", { label: "DAG · 01a10998" });
    expect(rosterPanes([omo, viewer, alone]).map((entry) => entry.pane_id)).toEqual(["omo", "dag2"]);
    expect(rosterPanes([viewer]).map((entry) => entry.pane_id)).toEqual(["dag"]);
  });

  it("keeps every other pane", () => {
    const shell = pane("sh", "t1");
    expect(rosterPanes([omo, shell]).map((entry) => entry.pane_id)).toEqual(["omo", "sh"]);
  });
});
