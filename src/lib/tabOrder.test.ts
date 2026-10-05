import { describe, expect, it } from "bun:test";

import { dropGap, movedTabOrder, stepGap } from "./tabOrder.ts";

const row = ["a", "b", "c", "d"];

describe("tab order", () => {
  // the cases are the ones herdr 0.9.3's tab.move answered, from the same starting row
  it("moves a tab into the gap before the one at the index, counted before the move", () => {
    expect(movedTabOrder(row, "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(movedTabOrder(row, "a", 2)).toEqual(["b", "a", "c", "d"]);
    expect(movedTabOrder(row, "c", 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("puts a tab last at the tab count", () => {
    expect(movedTabOrder(row, "a", 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("changes nothing at the gaps on either side of the tab, out of the row, or for a tab not in it", () => {
    expect(movedTabOrder(row, "b", 1)).toBeNull();
    expect(movedTabOrder(row, "b", 2)).toBeNull();
    expect(movedTabOrder(row, "b", 5)).toBeNull();
    expect(movedTabOrder(row, "b", -1)).toBeNull();
    expect(movedTabOrder(row, "b", 1.5)).toBeNull();
    expect(movedTabOrder(row, "x", 0)).toBeNull();
  });

  it("steps a tab one place, and not past either end", () => {
    expect(movedTabOrder(row, "b", stepGap(row, "b", -1)!)).toEqual(["b", "a", "c", "d"]);
    expect(movedTabOrder(row, "b", stepGap(row, "b", 1)!)).toEqual(["a", "c", "b", "d"]);
    expect(movedTabOrder(row, "c", stepGap(row, "c", 1)!)).toEqual(["a", "b", "d", "c"]);
    expect(stepGap(row, "a", -1)).toBeNull();
    expect(stepGap(row, "d", 1)).toBeNull();
    expect(stepGap(row, "x", 1)).toBeNull();
  });

  it("drops a tab before the target, or after it on the target's far half", () => {
    expect(movedTabOrder(row, "a", dropGap(row, "c", false)!)).toEqual(["b", "a", "c", "d"]);
    expect(movedTabOrder(row, "a", dropGap(row, "c", true)!)).toEqual(["b", "c", "a", "d"]);
    expect(movedTabOrder(row, "d", dropGap(row, "a", false)!)).toEqual(["d", "a", "b", "c"]);
    expect(movedTabOrder(row, "a", dropGap(row, "d", true)!)).toEqual(["b", "c", "d", "a"]);
    expect(dropGap(row, "x", false)).toBeNull();
  });
});
