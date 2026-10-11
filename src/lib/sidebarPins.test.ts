import { describe, expect, it } from "bun:test";
import { orderPinnedRows, pruneSidebarPins, sidebarPinKey, toggleSidebarPin } from "./sidebarPins.ts";

describe("sidebar agent pins", () => {
  it("keys a pin by PC and pane", () => {
    expect(sidebarPinKey("pc-a", "pane-1")).toBe("pc-a:pane-1");
    expect(sidebarPinKey("pc-b", "pane-1")).not.toBe(sidebarPinKey("pc-a", "pane-1"));
  });

  it("toggles pins without changing the saved order of other pins", () => {
    expect(toggleSidebarPin(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSidebarPin(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("prunes only panes absent from the live roster", () => {
    expect(pruneSidebarPins(["pc-a:p1", "pc-b:p1"], new Set(["pc-b:p1"]), [{ id: "pc-a", snapshot: {} }, { id: "pc-b", snapshot: {} }])).toEqual(["pc-b:p1"]);
  });

  it("keeps saved pins until each machine's agent roster has loaded", () => {
    const pins = ["local:p1", "remote:p2"];
    const live = new Set(["local:p1"]);
    expect(pruneSidebarPins(pins, new Set(), [])).toEqual(pins);
    expect(pruneSidebarPins(pins, new Set(), [{ id: "local", snapshot: null }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: null }])).toEqual(pins);
    expect(pruneSidebarPins(pins, live, [{ id: "local", snapshot: {} }, { id: "remote", snapshot: {} }])).toEqual(["local:p1"]);
  });

  it("places pinned rows first and keeps source order for the rest", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(orderPinnedRows(rows, ["c", "a"], (row) => row.id).map((row) => row.id)).toEqual(["c", "a", "b"]);
    expect(orderPinnedRows(rows, ["missing", "b"], (row) => row.id).map((row) => row.id)).toEqual(["b", "a", "c"]);
  });
});
