import { describe, expect, it } from "bun:test";
import { terminalZoomKey, terminalZoomWheel } from "./terminalZoom.ts";

const key = (value: string, patch: Partial<Parameters<typeof terminalZoomKey>[0]> = {}) => terminalZoomKey({ key: value, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...patch });

describe("terminal zoom input", () => {
  it("recognizes browser zoom chords with either platform modifier", () => {
    for (const modifier of [{ ctrlKey: true, metaKey: false }, { ctrlKey: false, metaKey: true }]) {
      expect(key("=", modifier)).toBe(1);
      expect(key("+", { ...modifier, shiftKey: true })).toBe(1);
      expect(key("-", modifier)).toBe(-1);
      expect(key("0", modifier)).toBe(0);
    }
  });
  it("preserves text, IME, Alt chords, and terminal undo", () => {
    expect(key("=", { ctrlKey: false })).toBeNull();
    expect(key("+", { isComposing: true })).toBeNull();
    expect(key("+", { keyCode: 229 })).toBeNull();
    expect(key("=", { altKey: true })).toBeNull();
    expect(key("=", { metaKey: true })).toBeNull();
    expect(key("_", { shiftKey: true })).toBeNull();
    expect(key("-", { shiftKey: true })).toBeNull();
    expect(key("c")).toBeNull();
  });
  it("accumulates smooth wheel deltas, handles line/page units, and resets on reversal", () => {
    expect(terminalZoomWheel(0, -30, 0)).toEqual({ remainder: -30, steps: 0 });
    expect(terminalZoomWheel(-30, -80, 0)).toEqual({ remainder: -10, steps: 1 });
    expect(terminalZoomWheel(-90, 10, 0)).toEqual({ remainder: 10, steps: 0 });
    expect(terminalZoomWheel(0, 3, 1)).toEqual({ remainder: 20, steps: -1 });
    expect(terminalZoomWheel(0, -1, 2)).toEqual({ remainder: 0, steps: 1 });
  });
});
