import { describe, expect, it } from "bun:test";
import type { PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import { paneStorageId, type PaneTarget } from "../../shared/machines.ts";
import {
  dockCells, dockDividers, dockFromNative, dockNeighbor, dockPane, dockTargetKey, dockTargets, fitDockLayout,
  parseDockLayout, pruneDock, removeDockPane, replaceDockPane, resizeDockPane, resizeDockSplit,
  swapDockPanes, type DockNode,
} from "./dock-layout.ts";
import type { Direction } from "./split-layout.ts";

const A: PaneTarget = { machine_id: "local", pane_id: "A" };
const B: PaneTarget = { machine_id: "local", pane_id: "B" };
const C: PaneTarget = { machine_id: "ssh/server", pane_id: "C" };
const D: PaneTarget = { machine_id: "local", pane_id: "D" };
const leaf = (target: PaneTarget): DockNode => ({ kind: "pane", target });
const pair: DockNode = { kind: "split", id: "root", direction: "right", ratio: 0.6, first: leaf(A), second: leaf(B) };
const nested: DockNode = {
  ...pair, second: { kind: "split", id: "inner", direction: "down", ratio: 0.5, first: leaf(B), second: leaf(C) },
};
const keys = (root: DockNode | null): string[] => dockTargets(root).map(dockTargetKey);

describe("dock identity and insertion", () => {
  it("redistributes nested horizontal splits to keep all four views readable", () => {
    const three = dockPane(pair, C, dockTargetKey(A), "left", "third");
    const four = dockPane(three, D, dockTargetKey(C), "left", "fourth");
    const fitted = fitDockLayout(four, 1200, 900, 272, 204);
    expect(keys(fitted)).toEqual(keys(four));
    for (const cell of dockCells(fitted)) expect(cell.box.width * 12).toBeGreaterThanOrEqual(271.999);
    expect(fitDockLayout(fitted, 1200, 900, 272, 204)).toEqual(fitted);
  });

  it("fits both axes and remains bounded when no minimum can fit", () => {
    const fitted = fitDockLayout(nested, 240, 180, 272, 204);
    expect(keys(fitted)).toEqual(keys(nested));
    for (const cell of dockCells(fitted)) {
      expect(cell.box.width).toBeGreaterThan(0);
      expect(cell.box.height).toBeGreaterThan(0);
      expect(cell.box.left + cell.box.width).toBeLessThanOrEqual(100);
      expect(cell.box.top + cell.box.height).toBeLessThanOrEqual(100);
    }
    expect(fitDockLayout(nested, 0, 0, 272, 204)).toBe(nested);
  });

  it("arranges panes from unrelated folders and workspaces without using cwd", () => {
    // Given: targets from unrelated sidebar projects; metadata is intentionally not an identity.
    const projectA = { ...A, cwd: "/projects/one", workspace_id: "one" };
    const projectB = { ...B, cwd: "/elsewhere/two", workspace_id: "two" };
    // When
    const result = dockPane(leaf(projectA), projectB, dockTargetKey(projectA), "right", "cross");
    const moved = { ...projectA, cwd: "/moved" };
    // Then
    expect(keys(result)).toEqual(["A", "B"]);
    expect(dockTargetKey(moved)).toBe("A");
  });

  it("keeps identical pane IDs on different machines distinct", () => {
    const remote = { machine_id: "ssh/server", pane_id: "A" };
    const result = dockPane(leaf(A), remote, "A", "down", "remote");
    expect(keys(result)).toEqual(["A", paneStorageId("ssh/server", "A")]);
    expect(parseDockLayout(result)).toEqual(result);
  });

  it("creates one pane when starting from null", () => {
    expect(dockPane(null, A, null, "left", "unused")).toEqual(leaf(A));
    expect(dockCells(null)).toEqual([]);
    expect(dockDividers(null)).toEqual([]);
  });

  const placements: { edge: Direction; box: { left: number; top: number; width: number; height: number } }[] = [
    { edge: "left", box: { left: 60, top: 0, width: 20, height: 100 } },
    { edge: "right", box: { left: 80, top: 0, width: 20, height: 100 } },
    { edge: "up", box: { left: 60, top: 0, width: 40, height: 50 } },
    { edge: "down", box: { left: 60, top: 50, width: 40, height: 50 } },
  ];
  for (const { edge, box } of placements) {
    it(`places a new pane on the nested ${edge} edge`, () => {
      const result = dockPane(pair, C, "B", edge, `insert-${edge}`);
      expect(dockCells(result).find((cell) => dockTargetKey(cell.target) === dockTargetKey(C))?.box).toEqual(box);
      expect(dockDividers(result).map((divider) => divider.splitId)).toEqual(["root", `insert-${edge}`]);
      expect(pair.second).toEqual(leaf(B));
    });
  }

  it("moves a nested source, collapses its old branch, and preserves every other pane", () => {
    const result = dockPane(nested, B, "A", "left", "move");
    expect(keys(result)).toEqual(["B", "A", dockTargetKey(C)]);
    expect(dockDividers(result).map((divider) => divider.splitId)).toEqual(["root", "move"]);
    expect(keys(nested)).toEqual(["A", "B", dockTargetKey(C)]);
  });

  it("moves the root's first pane beside a deeply nested anchor without losing siblings", () => {
    const result = dockPane(nested, A, dockTargetKey(C), "down", "move");
    expect(keys(result)).toEqual(["B", dockTargetKey(C), "A"]);
    expect(dockDividers(result).map((divider) => divider.splitId)).toEqual(["inner", "move"]);
  });

  it("preserves the original tree on a self-drop or a missing nonnull anchor", () => {
    expect(dockPane(nested, B, "B", "right", "self")).toBe(nested);
    expect(dockPane(nested, B, "gone", "right", "bad")).toBe(nested);
    expect(dockPane(nested, D, "gone", "left", "bad")).toBe(nested);
  });

  it("splits the whole tree when the anchor is null", () => {
    const result = dockPane(pair, C, null, "up", "whole");
    expect(dockCells(result).find((cell) => cell.target === C)?.box).toEqual({ left: 0, top: 0, width: 100, height: 50 });
    expect(keys(result)).toEqual([dockTargetKey(C), "A", "B"]);
  });
});

describe("dock tree edits", () => {
  it("collapses empty ancestors when removing a pane", () => {
    const result = removeDockPane(nested, "B");
    expect(result).toEqual({ ...pair, second: leaf(C) });
    expect(removeDockPane(leaf(A), "A")).toBeNull();
    expect(removeDockPane(nested, "gone")).toBe(nested);
  });

  it("prunes whole branches and retains the original reference when nothing changes", () => {
    expect(pruneDock(nested, (target) => target.machine_id !== "local")).toEqual(leaf(C));
    expect(pruneDock(nested, () => false)).toBeNull();
    expect(pruneDock(nested, () => true)).toBe(nested);
  });

  it("replaces a pane at its current geometry without duplicating an existing target", () => {
    const result = replaceDockPane(nested, "B", D);
    expect(keys(result)).toEqual(["A", "D", dockTargetKey(C)]);
    expect(dockCells(result).find((cell) => cell.target === D)?.box).toEqual({ left: 60, top: 0, width: 40, height: 50 });
    expect(replaceDockPane(nested, "B", A)).toBe(nested);
    expect(replaceDockPane(nested, "gone", D)).toBe(nested);
    expect(replaceDockPane(null, "A", D)).toBeNull();
  });

  it("swaps target identities while keeping divider geometry", () => {
    const result = swapDockPanes(nested, "A", dockTargetKey(C));
    expect(keys(result)).toEqual([dockTargetKey(C), "B", "A"]);
    expect(dockDividers(result)).toEqual(dockDividers(nested));
    expect(swapDockPanes(nested, "A", "gone")).toBe(nested);
    expect(swapDockPanes(nested, "A", "A")).toBe(nested);
  });
});

describe("dock geometry", () => {
  it("projects nested cells and dividers in percentages", () => {
    expect(dockCells(nested)).toEqual([
      { target: A, box: { left: 0, top: 0, width: 60, height: 100 } },
      { target: B, box: { left: 60, top: 0, width: 40, height: 50 } },
      { target: C, box: { left: 60, top: 50, width: 40, height: 50 } },
    ]);
    expect(dockDividers(nested)).toEqual([
      { splitId: "root", orientation: "vertical", direction: "right", ratio: 0.6, position: 60, start: 0, length: 100 },
      { splitId: "inner", orientation: "horizontal", direction: "down", ratio: 0.5, position: 50, start: 60, length: 40 },
    ]);
  });

  it("clamps resized splits and keeps nested divider lengths inside the parent", () => {
    const result = resizeDockSplit(nested, "root", 12);
    expect(dockDividers(result)[0]?.position).toBe(90);
    expect(dockDividers(result)[1]?.length).toBe(10);
    expect(dockCells(resizeDockSplit(nested, "inner", -5)).find((cell) => cell.target === B)?.box.height).toBe(10);
    expect(resizeDockSplit(nested, "gone", 0.2)).toBe(nested);
    expect(resizeDockSplit(nested, "root", NaN)).toBe(nested);
  });

  it("chooses neighbors by shared border and topmost tie breaking", () => {
    expect(dockNeighbor(nested, "A", "right")).toEqual(B);
    expect(dockNeighbor(nested, "B", "down")).toEqual(C);
    expect(dockNeighbor(nested, dockTargetKey(C), "up")).toEqual(B);
    expect(dockNeighbor(nested, "B", "left")).toEqual(A);
    expect(dockNeighbor(resizeDockSplit(nested, "inner", 0.25), "A", "right")).toEqual(C);
    expect(dockNeighbor(nested, "A", "up")).toBeNull();
    expect(dockNeighbor(nested, "gone", "left")).toBeNull();
  });

  it("does not count corner contact as a neighboring edge", () => {
    const grid = dockPane(dockPane(leaf(A), B, "A", "down", "left"), C, null, "right", "outer");
    const result = dockPane(grid, D, dockTargetKey(C), "down", "right");
    expect(dockNeighbor(result, "A", "right")).toEqual(C);
    expect(dockNeighbor(result, "B", "right")).toEqual(D);
  });
});

describe("keyboard dock resizing", () => {
  it("grows toward right and down using the nearest adjacent divider", () => {
    expect(dockDividers(resizeDockPane(nested, "A", "right"))[0]?.ratio).toBeCloseTo(0.65);
    expect(dockDividers(resizeDockPane(nested, "B", "down", 0.1))[1]?.ratio).toBeCloseTo(0.6);
  });

  it("grows toward left and up using the enclosing adjacent divider", () => {
    expect(dockDividers(resizeDockPane(nested, "B", "left"))[0]?.ratio).toBeCloseTo(0.55);
    expect(dockDividers(resizeDockPane(nested, dockTargetKey(C), "up"))[1]?.ratio).toBeCloseTo(0.45);
  });

  it("prefers a nested divider on the same axis and clamps its ratio", () => {
    const deeper = dockPane(pair, C, "A", "right", "near");
    const result = resizeDockPane(deeper, "A", "right", 2);
    expect(dockDividers(result).map((divider) => divider.ratio)).toEqual([0.6, 0.9]);
  });

  it("walks past a nonadjacent inner divider to an adjacent ancestor", () => {
    const deeper = dockPane(pair, C, "A", "right", "near");
    const result = resizeDockPane(deeper, dockTargetKey(C), "right");
    expect(dockDividers(result).map((divider) => divider.ratio)).toEqual([0.65, 0.5]);
  });

  it("preserves the tree at outer edges, for missing targets, and for invalid amounts", () => {
    expect(resizeDockPane(nested, "A", "left")).toBe(nested);
    expect(resizeDockPane(nested, "gone", "right")).toBe(nested);
    expect(resizeDockPane(nested, "A", "right", NaN)).toBe(nested);
    expect(resizeDockPane(nested, "A", "right", -1)).toBe(nested);
    expect(resizeDockPane(null, "A", "right")).toBeNull();
  });
});

describe("persisted dock parsing", () => {
  it("round trips a valid tree and copies persisted target values", () => {
    const result = parseDockLayout(nested);
    expect(result).toEqual(nested);
    expect(result).not.toBe(nested);
    expect(dockTargets(result)[0]).not.toBe(A);
  });

  const invalid: unknown[] = [
    null, undefined, [], "pane", {}, { kind: "other" },
    { kind: "pane", target: { machine_id: "", pane_id: "A" } },
    { kind: "pane", target: { machine_id: "local", pane_id: "  " } },
    { kind: "pane", target: { machine_id: 1, pane_id: "A" } },
    { ...pair, first: null }, { ...pair, second: {} }, { ...pair, direction: "left" },
    { ...pair, id: "" }, { ...pair, ratio: NaN }, { ...pair, ratio: Infinity },
    { ...pair, ratio: 0.09 }, { ...pair, ratio: 0.91 }, { ...pair, ratio: "0.5" },
    { ...pair, second: leaf(A) }, { ...nested, second: { ...pair, first: leaf(C), second: leaf(D) } },
  ];
  for (const [index, value] of invalid.entries()) {
    it(`rejects the entire malformed persisted tree ${index}`, () => {
      expect(parseDockLayout(value)).toBeNull();
    });
  }

  it("rejects cycles without overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { ...pair };
    cyclic.second = cyclic;
    expect(parseDockLayout(cyclic)).toBeNull();
  });

  it("rejects unsafe nesting depth", () => {
    let deep: DockNode = leaf(A);
    for (let i = 0; i < 66; i++) {
      deep = { kind: "split", id: `deep-${i}`, direction: "right", ratio: 0.5,
        first: deep, second: leaf({ machine_id: "local", pane_id: `p-${i}` }) };
    }
    expect(parseDockLayout(deep)).toBeNull();
  });

  it("rejects oversized shallow trees at the persisted node budget", () => {
    const build = (depth: number, id: string): DockNode => depth === 0
      ? leaf({ machine_id: "local", pane_id: `pane-${id}` })
      : { kind: "split", id, direction: "right", ratio: 0.5,
        first: build(depth - 1, `${id}0`), second: build(depth - 1, `${id}1`) };
    const oversized = build(12, "tree");
    expect(parseDockLayout(oversized)).toBeNull();
  });
});

const area = { x: 10, y: 5, width: 120, height: 40 };
const native: PaneLayoutSnapshot = {
  area, focused_pane_id: "B", tab_id: "tab/one", workspace_id: "workspace/two", zoomed: false,
  panes: [
    { pane_id: "C", focused: false, rect: { x: 82, y: 25, width: 48, height: 20 } },
    { pane_id: "A", focused: false, rect: { x: 10, y: 5, width: 72, height: 40 } },
    { pane_id: "B", focused: true, rect: { x: 82, y: 5, width: 48, height: 20 } },
  ],
  splits: [
    { id: "inner", direction: "down", ratio: 0.5, rect: { x: 82, y: 5, width: 48, height: 40 } },
    { id: "root", direction: "right", ratio: 0.6, rect: area },
  ],
};

describe("native dock conversion", () => {
  it("preserves a three-pane geometry independent of native array order", () => {
    const result = dockFromNative(native, "local", "C");
    expect(dockCells(result).map((cell) => cell.box)).toEqual(dockCells(nested).map((cell) => cell.box));
    expect(keys(result)).toEqual(["A", "B", "C"]);
    expect(dockDividers(result).map((divider) => divider.splitId)).toEqual([
      "native:local:workspace%2Ftwo:tab%2Fone:root", "native:local:workspace%2Ftwo:tab%2Fone:inner",
    ]);
  });

  it("preserves a two-pane native split when adding a cross-project target", () => {
    const two: PaneLayoutSnapshot = {
      ...native, panes: [
        { pane_id: "A", focused: true, rect: { x: 10, y: 5, width: 72, height: 40 } },
        { pane_id: "B", focused: false, rect: { x: 82, y: 5, width: 48, height: 40 } },
      ], splits: [{ id: "root", direction: "right", ratio: 0.6, rect: area }],
    };
    const result = dockPane(dockFromNative(two, "local", "A"), C, "B", "down", "new");
    expect(dockCells(result)).toEqual(dockCells(nested));
  });

  it("converts a horizontal native split and namespaces different machines", () => {
    const stacked: PaneLayoutSnapshot = {
      ...native, panes: [
        { pane_id: "A", focused: true, rect: { ...area, height: 10 } },
        { pane_id: "B", focused: false, rect: { ...area, y: 15, height: 30 } },
      ], splits: [{ id: "root", direction: "down", ratio: 0.25, rect: area }],
    };
    const result = dockFromNative(stacked, "ssh/server", null);
    expect(dockDividers(result)[0]?.position).toBe(25);
    expect(keys(result)).toEqual([paneStorageId("ssh/server", "A"), paneStorageId("ssh/server", "B")]);
    expect(dockDividers(result)[0]?.splitId).not.toBe(dockDividers(dockFromNative(stacked, "local", null))[0]?.splitId);
  });

  it("uses only the active visible pane when native zoom is enabled", () => {
    expect(dockFromNative({ ...native, zoomed: true }, "local", "C")).toEqual(leaf({ machine_id: "local", pane_id: "C" }));
    expect(dockFromNative({ ...native, zoomed: true }, "local", "gone")).toEqual(leaf(B));
    expect(dockFromNative({ ...native, zoomed: true, focused_pane_id: "gone" }, "local", null)).toBeNull();
  });

  it("handles single panes and rejects empty or unreconstructable native layouts", () => {
    expect(dockFromNative({ ...native, panes: [{ pane_id: "A", focused: true, rect: area }], splits: [] }, "local", null)).toEqual(leaf(A));
    expect(dockFromNative({ ...native, panes: [] }, "local", null)).toBeNull();
    expect(dockFromNative({ ...native, splits: [] }, "local", null)).toBeNull();
    expect(dockFromNative({ ...native, area: { ...area, width: 0 } }, "local", null)).toBeNull();
  });
});
