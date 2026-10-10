import { describe, expect, it } from "bun:test";
import type { PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/protocol.ts";
import { resizeLayout } from "./layoutTree.ts";

const rect = (x: number, y: number, width: number, height: number): PaneLayoutRect => ({ x, y, width, height });
const area = rect(0, 0, 120, 40);
const tab = (panes: { id: string; rect: PaneLayoutRect }[]): PaneLayoutSnapshot => ({
  workspace_id: "w1", tab_id: "w1:t1", zoomed: false, area, focused_pane_id: panes[0]!.id,
  panes: panes.map((pane) => ({ pane_id: pane.id, focused: false, rect: pane.rect })),
  splits: [],
});
const rectOf = (panes: PaneLayoutSnapshot["panes"], id: string): PaneLayoutRect => panes.find((pane) => pane.pane_id === id)!.rect;

/** the rects tile the area: each inside it, none over another, and together they cover it */
function expectTiling(panes: PaneLayoutSnapshot["panes"]): void {
  let covered = 0;
  for (const [index, pane] of panes.entries()) {
    const { x, y, width, height } = pane.rect;
    expect(x >= area.x && y >= area.y && x + width <= area.x + area.width && y + height <= area.y + area.height).toBe(true);
    covered += width * height;
    for (const other of panes.slice(index + 1)) {
      const o = other.rect;
      expect(o.x >= x + width || x >= o.x + o.width || o.y >= y + height || y >= o.y + o.height).toBe(true);
    }
  }
  expect(covered).toBe(area.width * area.height);
}

// split right, then the right pane down: the review's layout
const nested = tab([{ id: "left", rect: rect(0, 0, 60, 40) }, { id: "top", rect: rect(60, 0, 60, 20) }, { id: "bottom", rect: rect(60, 20, 60, 20) }]);

describe("resizeLayout", () => {
  it("moves the split the border belongs to and lays every pane under it out again", () => {
    const wider = resizeLayout(nested, "left", "right", 0.05)!;
    expect(rectOf(wider, "left")).toEqual(rect(0, 0, 66, 40));
    expect(rectOf(wider, "top")).toEqual(rect(66, 0, 54, 20));
    expect(rectOf(wider, "bottom")).toEqual(rect(66, 20, 54, 20));
    expectTiling(wider);
  });

  it("moves the opposite border of a pane with no neighbour on the side named, as herdr does", () => {
    // nothing stands to the right of the top pane: the root split moves and the left pane grows
    const narrower = resizeLayout(nested, "top", "right", 0.05)!;
    expect(rectOf(narrower, "left").width).toBe(66);
    expect(rectOf(narrower, "top").x).toBe(66);
    expect(rectOf(narrower, "bottom").x).toBe(66);
    expectTiling(narrower);
  });

  it("leaves the panes outside the split alone", () => {
    const taller = resizeLayout(nested, "top", "down", 0.25)!;
    expect(rectOf(taller, "left")).toEqual(rect(0, 0, 60, 40));
    expect(rectOf(taller, "top")).toEqual(rect(60, 0, 60, 30));
    expect(rectOf(taller, "bottom")).toEqual(rect(60, 30, 60, 10));
    expectTiling(taller);
  });

  it("takes the amount on the split's own extent, caps it at herdr's half and holds the ratio to a tenth", () => {
    // a quarter of the inner split's 60 columns, not of the tab's 120
    const columns = tab([{ id: "left", rect: rect(0, 0, 60, 40) }, { id: "mid", rect: rect(60, 0, 30, 40) }, { id: "right", rect: rect(90, 0, 30, 40) }]);
    const mid = resizeLayout(columns, "mid", "right", 0.25)!;
    expect(rectOf(mid, "mid")).toEqual(rect(60, 0, 45, 40));
    expect(rectOf(mid, "right")).toEqual(rect(105, 0, 15, 40));
    expectTiling(mid);
    const most = resizeLayout(nested, "left", "right", 0.8)!;
    expect(rectOf(most, "left").width).toBe(108);
    expectTiling(most);
    expect(resizeLayout({ ...nested, panes: most }, "left", "right", 0.05)).toBeNull();
  });

  it("has nothing to move for a pane alone, an axis the pane fills, an unknown pane, or rects no split line cuts", () => {
    expect(resizeLayout(tab([{ id: "only", rect: area }]), "only", "right", 0.05)).toBeNull();
    expect(resizeLayout(nested, "left", "down", 0.05)).toBeNull();
    expect(resizeLayout(nested, "nope", "right", 0.05)).toBeNull();
    const pinwheel = tab([
      { id: "top", rect: rect(0, 0, 80, 10) }, { id: "right", rect: rect(80, 0, 40, 30) }, { id: "bottom", rect: rect(40, 30, 80, 10) },
      { id: "left", rect: rect(0, 10, 40, 30) }, { id: "centre", rect: rect(40, 10, 40, 20) },
    ]);
    expectTiling(pinwheel.panes);
    expect(resizeLayout(pinwheel, "centre", "right", 0.05)).toBeNull();
  });
});
