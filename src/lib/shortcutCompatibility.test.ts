import { expect, it } from "bun:test";
import * as shortcuts from "./shortcuts.ts";
import { recordShortcutBinding, sanitizeShortcutOverrides } from "./shortcutBindings.ts";

const modifiers = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: true };
const accentEvent = { key: "Ó", code: "Digit0", ...modifiers };

it("retains the physical digit and comma priority of legacy strings and defaults", () => {
  const legacy = sanitizeShortcutOverrides(JSON.parse(JSON.stringify({ palette: "0" })));
  expect(shortcuts.matchShortcut(accentEvent, true, legacy)).toBe("palette");
  expect(shortcuts.matchShortcut({ ...accentEvent, shiftKey: false }, true, legacy)).toBeNull();
  expect(shortcuts.matchShortcut({ ...accentEvent, altKey: true }, true, legacy)).toBeNull();
  expect(shortcuts.matchShortcut({ key: "K", code: "Comma", ...modifiers }, true)).toBe("settings");
});

it("prioritizes an exact object binding while keeping its logical accented Latin key", () => {
  const recorded = recordShortcutBinding(accentEvent)!;
  expect(recorded.key).toBe("ó");
  const overrides = sanitizeShortcutOverrides(JSON.parse(JSON.stringify({ palette: "0", find: recorded })));
  expect(shortcuts.matchShortcut(accentEvent, true, overrides)).toBe("find");
  expect(shortcuts.matchShortcut({ key: "0", code: "Digit0", ...modifiers }, true, overrides)).toBe("palette");
  const letter = { key: "K", code: "Comma", ...modifiers };
  expect(shortcuts.matchShortcut(letter, true, { palette: recordShortcutBinding(letter)! })).toBe("palette");
});

it("checks captured physical aliases against other actions, excluding the action being edited", () => {
  expect(shortcuts.shortcutEventConflict("find", accentEvent, { palette: "0" }, true)).toBe(true);
  expect(shortcuts.shortcutEventConflict("palette", accentEvent, { palette: "0" }, true)).toBe(false);
  const comma = { key: "K", code: "Comma", ...modifiers };
  expect(shortcuts.shortcutEventConflict("find", comma, {}, true)).toBe(true);
  expect(shortcuts.shortcutEventConflict("settings", comma, {}, true)).toBe(false);
  expect(shortcuts.shortcutEventConflict("find", { ...accentEvent, shiftKey: false }, { palette: "0" }, true)).toBe(false);
});

it("leaves invalid and IME keys alone before legacy aliases can dispatch", () => {
  for (const key of ["Dead", "Process", "Unidentified"]) {
    expect(shortcuts.matchShortcut({ key, code: "Digit0", ...modifiers }, true, { palette: "0" })).toBeNull();
    expect(shortcuts.matchShortcut({ key, code: "Comma", ...modifiers }, true)).toBeNull();
  }
});
