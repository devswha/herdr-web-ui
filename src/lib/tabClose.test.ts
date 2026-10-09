import { describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { tabCloseCost } from "./tabClose.ts";

const pane = (tab_id: string, agent_status: AgentStatus = "idle") => ({ tab_id, agent_status });

describe("tabCloseCost", () => {
  it("closes an idle tab at once when the workspace keeps another", () => {
    expect(tabCloseCost("t1", 2, [pane("t1"), pane("t2", "working")])).toBeNull();
    expect(tabCloseCost("t1", 2, [pane("t1", "done"), pane("t1", "unknown")])).toBeNull();
  });

  it("asks before the workspace's last tab, whatever runs in it", () => {
    expect(tabCloseCost("t1", 1, [pane("t1")])).toBe("last");
    expect(tabCloseCost("t1", 1, [pane("t1", "working")], { split: true })).toBe("last");
  });

  it("asks while an agent in the tab works or waits for an answer", () => {
    expect(tabCloseCost("t1", 3, [pane("t1"), pane("t1", "working")])).toBe("busy");
    expect(tabCloseCost("t1", 3, [pane("t1", "blocked")], { split: true })).toBe("busy");
  });

  it("asks about the panes beside one only where a single pane stands for the tab", () => {
    const split = [pane("t1"), pane("t1"), pane("t2")];
    expect(tabCloseCost("t1", 2, split)).toBeNull();
    expect(tabCloseCost("t1", 2, split, { split: true })).toBe("split");
    expect(tabCloseCost("t2", 2, split, { split: true })).toBeNull();
  });
});
