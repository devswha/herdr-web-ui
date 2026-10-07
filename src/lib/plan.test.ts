import { describe, expect, it } from "bun:test";

import type { PlanStep } from "../../shared/protocol.ts";
import { activityKind, activityTally, FLOW, flowLayout, planOutlook, planWaves, ranAlongside, stepsAfter, unfinishedBefore } from "./plan.ts";

const step = (id: string, blocked_by: string[] = [], status: PlanStep["status"] = "pending"): PlanStep =>
  ({ id, label: `step ${id}`, active: null, status, blocked_by, owner: null, started_at: null, ended_at: null });

describe("planWaves", () => {
  it("puts a step one wave after the last step it waits on, keeping the plan's order inside a wave", () => {
    const waves = planWaves([step("1"), step("2", ["1"]), step("3", ["1"]), step("4", ["2", "3"]), step("5")]);
    expect(waves.map((wave) => wave.map((s) => s.id))).toEqual([["1", "5"], ["2", "3"], ["4"]]);
  });

  it("ignores a wait on a step that is gone and does not follow a loop", () => {
    expect(planWaves([step("1", ["9"]), step("2", ["3"]), step("3", ["2"])]).flat().map((s) => s.id).sort()).toEqual(["1", "2", "3"]);
  });
});

describe("planOutlook", () => {
  it("tells the steps running, the ones that can start now and the ones still waiting on others", () => {
    const steps = [step("1", [], "completed"), step("2", ["1"], "in_progress"), step("3", ["1"]), step("4", ["2", "3"]), step("5", ["9"])];
    const outlook = planOutlook(steps);
    expect([outlook.running, outlook.ready, outlook.waiting].map((list) => list.map((s) => s.id))).toEqual([["2"], ["3", "5"], ["4"]]);
    expect(unfinishedBefore(steps[3]!, steps).map((s) => s.id)).toEqual(["2", "3"]);
    expect(stepsAfter(steps[0]!, steps).map((s) => s.id)).toEqual(["2", "3"]);
  });
});

describe("ranAlongside", () => {
  it("finds the steps whose run overlapped, a running one up to now", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 0, minute)).toISOString();
    const ran = (id: string, start: number, end: number | null, status: PlanStep["status"] = "completed"): PlanStep => ({ ...step(id, [], status), started_at: at(start), ended_at: end === null ? null : at(end) });
    const steps = [ran("1", 0, 10), ran("2", 5, 15), ran("3", 10, 20), ran("4", 12, null, "in_progress"), step("5")];
    const now = Date.parse(at(30));
    expect(ranAlongside(steps[0]!, steps, now).map((s) => s.id)).toEqual(["2"]);
    expect(ranAlongside(steps[3]!, steps, now).map((s) => s.id)).toEqual(["2", "3"]);
    expect(ranAlongside(steps[4]!, steps, now)).toEqual([]);
  });
});

describe("activityTally", () => {
  it("counts calls by what they did, and keeps a tool it cannot place by its name", () => {
    expect(activityTally([{ name: "Bash", count: 5 }, { name: "Edit", count: 2 }, { name: "MultiEdit", count: 2 }, { name: "Grep", count: 1 }, { name: "Glob", count: 1 }, { name: "Agent", count: 1 }, { name: "mcp__linear__get_issue", count: 3 }])).toEqual([
      { kind: "run", name: "Bash", count: 5 },
      { kind: "edit", name: "Edit", count: 4 },
      { kind: null, name: "mcp__linear__get_issue", count: 3 },
      { kind: "search", name: "Grep", count: 2 },
      { kind: "agent", name: "Agent", count: 1 },
    ]);
    expect(["exec_command", "apply_patch", "spawn_agent", "WebSearch", "update_plan"].map(activityKind)).toEqual(["run", "edit", "agent", "search", null]);
  });
});

describe("flowLayout", () => {
  it("centres each wave and draws a curve from each step waited on, open once that step is done", () => {
    const layout = flowLayout([step("1", [], "completed"), step("2", ["1"]), step("3", ["1"]), step("4", ["2", "3"])]);
    const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
    expect(layout.width).toBe(pad * 2 + 2 * nodeWidth + columnGap);
    expect(layout.height).toBe(pad * 2 + 3 * nodeHeight + 2 * rowGap);
    const one = layout.nodes.find((node) => node.step.id === "1")!;
    expect(one.x).toBe((layout.width - nodeWidth) / 2);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}:${edge.done}`)).toEqual(["1>2:true", "1>3:true", "2>4:false", "3>4:false"]);
    expect(layout.edges[0]!.path.startsWith(`M ${one.x + nodeWidth / 2} ${one.y + nodeHeight} C`)).toBe(true);
  });

  it("wraps a wave wider than the columns it may take onto more rows, with no curve between them", () => {
    const layout = flowLayout([step("1"), step("2"), step("3"), step("4"), step("5", ["1"])], 2);
    const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
    expect(layout.width).toBe(pad * 2 + 2 * nodeWidth + columnGap);
    expect(layout.nodes.map((node) => `${node.step.id}@${(node.y - pad) / (nodeHeight + rowGap)}`)).toEqual(["1@0", "2@0", "3@1", "4@1", "5@2"]);
    expect(layout.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual(["1>5"]);
  });

  it("lays out an empty plan as one empty column", () => {
    expect(flowLayout([])).toMatchObject({ nodes: [], edges: [] });
  });
});
