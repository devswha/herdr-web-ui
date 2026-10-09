import { expect, it } from "bun:test";
import type { Machine, PaneTarget } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { dockCells, dockDividers, dockTargets, parseDockLayout } from "./dock-layout.ts";
import { allSessionTargets, runningLayout, runningTargets, type LayoutPreset } from "./running-layout.ts";

const pane = (pane_id: string, agent_status = "working", background_tasks = 0): HerdrPane => ({
  pane_id, agent_status, background_tasks, focused: false, revision: 1,
  tab_id: "tab", terminal_id: pane_id, workspace_id: "workspace",
});
const machine = (id: string, panes: HerdrPane[], state: Machine["state"] = "connected"): Machine => ({
  id, name: id, kind: "ssh", enabled: true, state, error: null,
  snapshot: { panes, workspaces: [], tabs: [], layouts: [], agents: [], protocol: 1, version: "test" },
});

it("includes working and background sessions but excludes idle, blocked and restored failures", () => {
  const machines = [machine("local", [
    pane("working"), pane("background", "done", 2), pane("both", "working", 3),
    pane("idle", "idle"), pane("blocked", "blocked"), pane("done", "done"),
    { ...pane("failed"), restore_error: "Process not restored" },
  ])];
  const targets = runningTargets(machines);
  expect(targets).toEqual(["working", "background", "both"].map((pane_id) => ({ machine_id: "local", pane_id })));
  expect(machines[0]?.snapshot?.panes).toHaveLength(7);
});

it("keeps machine identity and excludes stale or missing rosters", () => {
  const targets = runningTargets([
    machine("local", [pane("same")]), machine("remote", [pane("same")]),
    machine("offline", [pane("stale")], "disconnected"),
    machine("reconnecting", [pane("stale")], "reconnecting"),
    { ...machine("missing", []), snapshot: null },
  ]);
  expect(targets).toEqual([
    { machine_id: "local", pane_id: "same" }, { machine_id: "remote", pane_id: "same" },
  ]);
});

it("handles no sessions and one session without an empty split", () => {
  const target = { machine_id: "local", pane_id: "one" };
  expect(runningLayout([])).toBeNull();
  expect(runningLayout([target])).toEqual({ kind: "pane", target });
});

it("gathers all statuses including completed and background sessions across connected PCs", () => {
  const doneWithoutCount = { ...pane("absent", "done"), background_tasks: undefined };
  const machines = [
    machine("local", [pane("done", "done"), doneWithoutCount, pane("background", "done", 2),
      pane("working"), pane("idle", "idle"), pane("blocked", "blocked"), pane("unknown", "unknown"),
      { ...pane("failed", "done"), restore_error: "Not restored" }]),
    machine("remote", [pane("done", "done")]),
    machine("offline", [pane("done", "done")], "disconnected"),
    machine("reconnecting", [pane("done", "done")], "reconnecting"),
    { ...machine("missing", []), snapshot: null },
  ];
  const targets = allSessionTargets(machines);
  expect(targets).toEqual([
    { machine_id: "local", pane_id: "done" },
    { machine_id: "local", pane_id: "absent" },
    { machine_id: "local", pane_id: "background" },
    { machine_id: "local", pane_id: "working" },
    { machine_id: "local", pane_id: "idle" },
    { machine_id: "local", pane_id: "blocked" },
    { machine_id: "local", pane_id: "unknown" },
    { machine_id: "remote", pane_id: "done" },
  ]);
  expect(runningTargets(machines).every((running) => targets.some((target) =>
    running.machine_id === target.machine_id && running.pane_id === target.pane_id))).toBe(true);
});

it("returns no overview targets for empty or unavailable rosters", () => {
  expect(allSessionTargets([machine("local", [])])).toEqual([]);
  expect(allSessionTargets([])).toEqual([]);
});

for (const count of [1, 2, 3, 4, 5, 8, 9, 12, 25]) {
  it(`arranges all ${count} sessions with valid persistent geometry and no overlap`, () => {
    const targets: PaneTarget[] = Array.from({ length: count }, (_, n) => ({ machine_id: "local", pane_id: String(n) }));
    const layout = runningLayout(targets);
    expect(dockTargets(layout)).toEqual(targets);
    expect(parseDockLayout(layout)).toEqual(layout);
    expect(new Set(dockDividers(layout).map((split) => split.splitId)).size).toBe(count - 1);
    const cells = dockCells(layout);
    const columns = Math.min(count, 4);
    expect(new Set(cells.map((cell) => cell.box.left)).size).toBe(columns);
    expect(dockDividers(layout).filter((split) => split.direction === "down")).toHaveLength(count - columns);
    for (const cell of cells) {
      expect(cell.box.width).toBeCloseTo(100 / columns);
      if (count <= 4) {
        expect(cell.box.height).toBe(100);
        expect(cell.box.top).toBe(0);
      }
    }
    expect(cells.reduce((area, cell) => area + cell.box.width * cell.box.height, 0)).toBeCloseTo(10000);
    for (const [index, { box }] of cells.entries()) {
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(box.left + box.width).toBeLessThanOrEqual(100.000001);
      expect(box.top + box.height).toBeLessThanOrEqual(100.000001);
      for (const { box: other } of cells.slice(index + 1)) {
        const width = Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left);
        const height = Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top);
        expect(width <= 0.000001 || height <= 0.000001).toBe(true);
      }
    }
  });
}

for (const [preset, count, columns, rows] of [
  ["2-columns", 2, 2, 1], ["3-columns", 3, 3, 1], ["4-columns", 4, 4, 1],
  ["2x2", 4, 2, 2], ["3x2", 6, 3, 2],
] as const) {
  it(`uses the requested ${preset} geometry for ${count} sessions`, () => {
    const targets = Array.from({ length: count }, (_, n) => ({ machine_id: "local", pane_id: String(n) }));
    const cells = dockCells(runningLayout(targets, preset));
    expect(new Set(cells.map((cell) => cell.box.left)).size).toBe(columns);
    expect(new Set(cells.map((cell) => cell.box.top)).size).toBe(rows);
    for (const { box } of cells) {
      expect(box.width).toBeCloseTo(100 / columns);
      expect(box.height).toBeCloseTo(100 / rows);
    }
  });
}

it("fills grid presets across rows and column presets down columns", () => {
  const targets = Array.from({ length: 4 }, (_, n) => ({ machine_id: "local", pane_id: String(n) }));
  expect(dockCells(runningLayout(targets, "2x2")).map(({ box }) => [box.left, box.top])).toEqual([
    [0, 0], [50, 0], [0, 50], [50, 50],
  ]);
  expect(dockCells(runningLayout(targets, "2-columns")).map(({ box }) => [box.left, box.top])).toEqual([
    [0, 0], [0, 50], [50, 0], [50, 50],
  ]);
});

for (const preset of ["auto", "2-columns", "3-columns", "4-columns", "2x2", "3x2"] satisfies LayoutPreset[]) {
  it(`keeps every session when ${preset} has fewer or more sessions than preview slots`, () => {
    for (const count of [1, 7, 13]) {
      const targets = Array.from({ length: count }, (_, n) => ({ machine_id: "local", pane_id: String(n) }));
      const layout = runningLayout(targets, preset);
      expect(dockTargets(layout)).toEqual(targets);
      expect(parseDockLayout(layout)).toEqual(layout);
      const cells = dockCells(layout);
      expect(cells.reduce((area, cell) => area + cell.box.width * cell.box.height, 0)).toBeCloseTo(10000);
      for (const [index, { box }] of cells.entries()) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        for (const { box: other } of cells.slice(index + 1)) {
          const width = Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left);
          const height = Math.min(box.top + box.height, other.top + other.height) - Math.max(box.top, other.top);
          expect(width <= 0.000001 || height <= 0.000001).toBe(true);
        }
      }
    }
    expect(runningLayout([], preset)).toBeNull();
  });
}
