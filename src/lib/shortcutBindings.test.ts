import { expect, it } from "bun:test";
import { manualShortcutBinding, recordShortcutBinding } from "./shortcutBindings.ts";
import { matchShortcut, shortcutConflict } from "./shortcuts.ts";

const modifiers = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: true };

it("rejects ambiguous manual symbols and non-Latin characters without limiting keyboard recording", () => {
  for (const [key, code, normalized] of [["<", "Comma", ","], ["!", "Digit1", "1"], ["ф", "KeyA", "a"]]) {
    expect(manualShortcutBinding(key!, modifiers)).toBeNull();
    const recorded = recordShortcutBinding({ key: key!, code, ...modifiers })!;
    expect(recorded.key).toBe(normalized!);
    expect(matchShortcut({ key: key!, code, ...modifiers }, true, { palette: recorded })).toBe("palette");
  }
});

it("accepts manual Latin letters and combining marks, ASCII digits, comma and named keys", () => {
  const previous = { ...modifiers, key: "k" };
  expect(manualShortcutBinding("Home", previous)?.key).toBe("Home");
  for (const [key, code] of [["Ó", "Digit0"], ["U\u030b", "Backslash"], ["İ", "KeyI"], ["ç", "KeyB"], ["7", "Digit7"], [",", "Comma"], ["Home", "Home"], ["PageUp", "PageUp"], ["F24", "F24"], ["Tab", "Tab"], ["Escape", "Escape"], ["Space", "Space"]]) {
    const candidate = manualShortcutBinding(key!, modifiers);
    const event = { key: key === "Space" ? " " : key!, code, ...modifiers };
    expect(candidate).toEqual(recordShortcutBinding(event));
    if (key !== "Space") expect(matchShortcut(event, true, { palette: candidate! })).toBe("palette");
  }
  for (const key of ["", "ab", "Shift", "Dead", "enter", "F25", "🙂", "@", "1\u0301"]) expect(manualShortcutBinding(key, modifiers)).toBeNull();
});

it("checks the real Settings conflict when a manual comma uses Command+Shift", () => {
  const comma = manualShortcutBinding(",", modifiers)!;
  expect(comma).toBeDefined();
  expect(shortcutConflict("palette", [comma], {}, true)).toBe(true);
  expect(matchShortcut({ key: "<", code: "Comma", ...modifiers }, true)).toBe("settings");
});
