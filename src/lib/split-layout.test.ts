import { describe, expect, it } from "bun:test";
import type { PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import { withSplitRatio, cells, cellView, dividers, layoutForPane, neighbor, ratioFromPointer, replacementAfterClose, resizeForDrag, screenOrder } from "./split-layout.ts";
import type { PaneView } from "./actions.ts";

const area = { x: 0, y: 0, width: 120, height: 40 };

/** A | B  (실측 2-패널) */
const two: PaneLayoutSnapshot = {
  area, focused_pane_id: "A", tab_id: "t1", workspace_id: "w", zoomed: false,
  panes: [
    { pane_id: "A", focused: true, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { pane_id: "B", focused: false, rect: { x: 60, y: 0, width: 60, height: 40 } },
  ],
  splits: [{ id: "root", direction: "right", ratio: 0.5, rect: area }],
};

/** A | (B / C) */
const nested: PaneLayoutSnapshot = {
  area, focused_pane_id: "B", tab_id: "t2", workspace_id: "w", zoomed: false,
  panes: [
    { pane_id: "A", focused: false, rect: { x: 0, y: 0, width: 60, height: 40 } },
    { pane_id: "B", focused: true, rect: { x: 60, y: 0, width: 60, height: 20 } },
    { pane_id: "C", focused: false, rect: { x: 60, y: 20, width: 60, height: 20 } },
  ],
  splits: [
    { id: "root", direction: "right", ratio: 0.5, rect: area },
    { id: "right", direction: "down", ratio: 0.5, rect: { x: 60, y: 0, width: 60, height: 40 } },
  ],
};

const single: PaneLayoutSnapshot = {
  area, focused_pane_id: "S", tab_id: "t3", workspace_id: "w", zoomed: false,
  panes: [{ pane_id: "S", focused: true, rect: area }], splits: [],
};

describe("screenOrder", () => {
  it("orders by visible columns rather than array or tree traversal order", () => {
    const views = [
      { id: "top-right", box: { left: 50, top: 0 } },
      { id: "bottom-left", box: { left: 0, top: 50 } },
      { id: "bottom-right", box: { left: 50, top: 50 } },
      { id: "top-left", box: { left: 0, top: 0 } },
    ];
    expect(screenOrder(views).map((view) => view.id)).toEqual(["top-left", "bottom-left", "top-right", "bottom-right"]);
    expect(views[0]?.id).toBe("top-right");
    expect(screenOrder([])).toEqual([]);
  });
  it("numbers only the visible cell when a native tab is zoomed", () => {
    expect(screenOrder(cells({ ...nested, zoomed: true }, "C")).map((cell) => cell.paneId)).toEqual(["C"]);
  });
});

describe("layoutForPane", () => {
  it("finds the multi-pane layout that holds the pane", () => {
    expect(layoutForPane({ layouts: [single, nested] }, "C")?.tab_id).toBe("t2");
  });
  it("answers null for a single-pane tab, an unknown pane, or no layouts", () => {
    expect(layoutForPane({ layouts: [single] }, "S")).toBeNull();
    expect(layoutForPane({ layouts: [two] }, "Z")).toBeNull();
    expect(layoutForPane({}, "A")).toBeNull();
    expect(layoutForPane(null, "A")).toBeNull();
    expect(layoutForPane({ layouts: [two] }, null)).toBeNull();
  });
  it("answers null when a rect is empty or outside the area", () => {
    const broken = { ...two, panes: [two.panes[0]!, { ...two.panes[1]!, rect: { x: 60, y: 0, width: 0, height: 40 } }] };
    const outside = { ...two, panes: [two.panes[0]!, { ...two.panes[1]!, rect: { x: 100, y: 0, width: 60, height: 40 } }] };
    const noArea = { ...two, area: { x: 0, y: 0, width: 0, height: 0 } };
    expect(layoutForPane({ layouts: [broken] }, "A")).toBeNull();
    expect(layoutForPane({ layouts: [outside] }, "A")).toBeNull();
    expect(layoutForPane({ layouts: [noArea] }, "A")).toBeNull();
  });
});

describe("cells", () => {
  it("turns rects into percentages of the area", () => {
    expect(cells(nested)).toEqual([
      { paneId: "A", focused: false, box: { left: 0, top: 0, width: 50, height: 100 } },
      { paneId: "B", focused: true, box: { left: 50, top: 0, width: 50, height: 50 } },
      { paneId: "C", focused: false, box: { left: 50, top: 50, width: 50, height: 50 } },
    ]);
  });
  it("shows only the focused pane, full size, when zoomed", () => {
    expect(cells({ ...nested, zoomed: true })).toEqual([
      { paneId: "B", focused: true, box: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });
  it("shows the active pane full size when zoomed and the user picked another pane of the tab", () => {
    expect(cells({ ...nested, zoomed: true }, "C")).toEqual([
      { paneId: "C", focused: false, box: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
    expect(cells({ ...nested, zoomed: true }, "B")).toEqual([
      { paneId: "B", focused: true, box: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });
  it("falls back to the focused pane when the active one is not in the tab", () => {
    expect(cells({ ...nested, zoomed: true }, "Z")).toEqual([
      { paneId: "B", focused: true, box: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });
  it("draws no cell for a pane the tab does not hold", () => {
    expect(cells({ ...nested, zoomed: true, focused_pane_id: "gone" }, "Z")).toEqual([]);
    expect(cells({ ...nested, zoomed: true, focused_pane_id: "gone" })).toEqual([]);
  });
  it("ignores the active pane when not zoomed", () => {
    expect(cells(nested, "C")).toEqual(cells(nested));
  });
});

describe("dividers", () => {
  it("places a vertical line for a right split and a horizontal one for a down split", () => {
    expect(dividers(nested)).toEqual([
      { splitId: "root", orientation: "vertical", position: 50, start: 0, length: 100, ratio: 0.5, direction: "right" },
      { splitId: "right", orientation: "horizontal", position: 50, start: 50, length: 50, ratio: 0.5, direction: "down" },
    ]);
  });
  it("has none when zoomed", () => {
    expect(dividers({ ...nested, zoomed: true })).toEqual([]);
  });
});

describe("neighbor", () => {
  it("moves across the shared edge, preferring the longest overlap", () => {
    expect(neighbor(nested, "A", "right")).toBe("B");
    expect(neighbor(nested, "B", "left")).toBe("A");
    expect(neighbor(nested, "C", "left")).toBe("A");
    expect(neighbor(nested, "B", "down")).toBe("C");
    expect(neighbor(nested, "C", "up")).toBe("B");
  });
  it("answers null at the edge, for an unknown pane, or when zoomed", () => {
    expect(neighbor(nested, "A", "left")).toBeNull();
    expect(neighbor(nested, "Z", "right")).toBeNull();
    expect(neighbor({ ...nested, zoomed: true }, "B", "left")).toBeNull();
  });
});

describe("resizeForDrag", () => {
  it("grows the leading pane toward right/down with the ratio delta", () => {
    expect(resizeForDrag(two, "root", 0.7)).toEqual({ paneId: "A", direction: "right", amount: 0.2 });
    expect(resizeForDrag(nested, "right", 0.25)).toEqual({ paneId: "B", direction: "up", amount: 0.25 });
  });
  it("clamps to 0.1..0.9 and answers null when nothing would change", () => {
    expect(resizeForDrag(two, "root", 0.99)).toEqual({ paneId: "A", direction: "right", amount: 0.4 });
    expect(resizeForDrag(two, "root", 0.502)).toBeNull();
    expect(resizeForDrag({ ...two, splits: [{ ...two.splits[0]!, ratio: 0.9 }] }, "root", 0.95)).toBeNull();
    expect(resizeForDrag(two, "missing", 0.7)).toBeNull();
  });
});

describe("ratioFromPointer", () => {
  it("maps a pointer fraction of the container to the split's own ratio", () => {
    expect(ratioFromPointer(two, "root", 0.75)).toBeCloseTo(0.75);
    // the down split spans the whole height: pointer at 25% of the container is ratio 0.25
    expect(ratioFromPointer(nested, "right", 0.25)).toBeCloseTo(0.25);
  });
});

describe("cellView", () => {
  const stored = (views: Record<string, PaneView>) => (paneId: string): PaneView => views[paneId] ?? "terminal";

  it("shows the active cell in the lens App holds for it", () => {
    expect(cellView("A", "A", "chat", stored({ A: "terminal" }))).toBe("chat");
    expect(cellView("A", "A", "terminal", stored({ A: "chat" }))).toBe("terminal");
  });

  it("shows every other cell in its own pane's remembered lens", () => {
    const views = stored({ A: "chat", B: "chat", C: "terminal" });
    expect(cellView("B", "A", "terminal", views)).toBe("chat");
    expect(cellView("C", "A", "chat", views)).toBe("terminal");
  });

  it("keeps the lens a pane was switched to after another pane becomes active", () => {
    const views: Record<string, PaneView> = { A: "terminal", B: "terminal" };
    // the header toggle on active A stores its lens (App's setView)
    views.A = "chat";
    expect(cellView("A", "B", "terminal", stored(views))).toBe("chat");
  });

  it("asks for a stored lens only for cells that are not active", () => {
    const asked: string[] = [];
    cellView("A", "A", "chat", (paneId) => { asked.push(paneId); return "terminal"; });
    expect(asked).toEqual([]);
  });
});

describe("replacementAfterClose", () => {
  it("takes the neighbor on the left first, then up, right, down", () => {
    expect(replacementAfterClose(nested, "B")).toBe("A"); // left beats down (C)
    expect(replacementAfterClose(nested, "C")).toBe("A"); // left beats up (B)
    expect(replacementAfterClose(two, "A")).toBe("B"); // only right
    const stacked: PaneLayoutSnapshot = {
      ...two, panes: [
        { pane_id: "T", focused: true, rect: { x: 0, y: 0, width: 120, height: 20 } },
        { pane_id: "U", focused: false, rect: { x: 0, y: 20, width: 120, height: 20 } },
      ], splits: [{ id: "root", direction: "down", ratio: 0.5, rect: area }],
    };
    expect(replacementAfterClose(stacked, "U")).toBe("T"); // up
    expect(replacementAfterClose(stacked, "T")).toBe("U"); // down
  });
  it("takes any other pane of the tab when none touches (a zoomed tab)", () => {
    expect(replacementAfterClose({ ...nested, zoomed: true }, "B")).toBe("A");
  });
  it("answers null for a pane the tab does not hold or a tab with nothing else", () => {
    expect(replacementAfterClose(nested, "Z")).toBeNull();
    expect(replacementAfterClose(single, "S")).toBeNull();
  });
});

describe("withSplitRatio", () => {
  const rect = (layout: PaneLayoutSnapshot, id: string) => layout.panes.find((pane) => pane.pane_id === id)!.rect;

  it("moves a right split's boundary and stretches the panes on each side", () => {
    const next = withSplitRatio(two, "root", 0.75);
    expect(rect(next, "A")).toEqual({ x: 0, y: 0, width: 90, height: 40 });
    expect(rect(next, "B")).toEqual({ x: 90, y: 0, width: 30, height: 40 });
    expect(next.splits[0]!.ratio).toBe(0.75);
  });

  it("carries nested panes and splits along with the outer boundary", () => {
    const next = withSplitRatio(nested, "root", 0.25);
    expect(rect(next, "A")).toEqual({ x: 0, y: 0, width: 30, height: 40 });
    expect(rect(next, "B")).toEqual({ x: 30, y: 0, width: 90, height: 20 });
    expect(rect(next, "C")).toEqual({ x: 30, y: 20, width: 90, height: 20 });
    expect(next.splits[1]).toEqual({ ...nested.splits[1]!, rect: { x: 30, y: 0, width: 90, height: 40 } });
  });

  it("moves a down split inside its own rect only", () => {
    const next = withSplitRatio(nested, "right", 0.25);
    expect(rect(next, "A")).toEqual(rect(nested, "A"));
    expect(rect(next, "B")).toEqual({ x: 60, y: 0, width: 60, height: 10 });
    expect(rect(next, "C")).toEqual({ x: 60, y: 10, width: 60, height: 30 });
  });

  it("clamps to 0.1..0.9 and leaves an unknown split's layout as it was", () => {
    expect(withSplitRatio(two, "root", 0.99).splits[0]!.ratio).toBe(0.9);
    expect(withSplitRatio(two, "root", -1).splits[0]!.ratio).toBe(0.1);
    expect(withSplitRatio(two, "missing", 0.7)).toBe(two);
  });
});
