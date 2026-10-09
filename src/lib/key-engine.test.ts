import { describe, expect, it } from "bun:test";
import { compileKeymap, PREFIX_TIMEOUT_MS, resolveKey, type KeyContext } from "./key-engine.ts";
import { parseBinding, chordOfEvent } from "./key-chord.ts";
import type { HerdrKeymap } from "../../shared/herdr-keymap.ts";
import { matchShortcut, type ShortcutEventLike } from "./shortcuts.ts";
import { sanitizeSettings } from "./settings.ts";

const context: KeyContext = { now: 100, prefixUntil: 0, enabled: true, inTextField: false, modalOpen: false, composing: false };
const event = (key: string, patch: Partial<ShortcutEventLike> = {}): ShortcutEventLike =>
  ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...patch });
const map = (patch: Partial<HerdrKeymap> = {}): HerdrKeymap => ({
  prefix: ["ctrl+b"], bindings: [{ action: "new_tab", keys: ["prefix+c"] }], commands: [], ...patch,
});
const mac = { mac: true, overrides: {} };

describe("optional import and web ownership", () => {
  it("stays off for old or malformed preferences, without changing overrides", () => {
    for (const value of [undefined, false, "true", 1]) {
      const loaded = sanitizeSettings({ importHerdrKeys: value, shortcutOverrides: { palette: "8", settings: null } });
      expect(loaded.importHerdrKeys).toBe(false);
      expect(loaded.shortcutOverrides).toEqual({ palette: "8", settings: null });
    }
    expect(sanitizeSettings({ importHerdrKeys: true }).importHerdrKeys).toBe(true);
  });

  it("keeps configured web chords, default aliases and dictation even when disabled", () => {
    const overrides = { palette: "8", "new-session": null, "toggle-sidebar": null };
    const compiled = compileKeymap(map({ bindings: [
      { action: "new_tab", keys: ["cmd+shift+8", "cmd+shift+k", "cmd+shift+n", "cmd+shift+b", "cmd+shift+space"] },
    ] }), { mac: true, overrides });
    expect(compiled.direct.size).toBe(0);
    expect(matchShortcut(event("8", { metaKey: true, shiftKey: true }), true, overrides)).toBe("palette");
    expect(compiled.report.filter((row) => row.action === "new_tab").every((row) => row.status === "protected")).toBe(true);
  });

  it("never imports browser or clipboard shortcuts, including after a prefix", () => {
    for (const macPlatform of [false, true]) {
      const chords = ["cmd+t", "ctrl+t", "cmd+c", "ctrl+v", "ctrl+shift+v", "alt+left", "cmd+shift+6", "ctrl+shift+q"];
      const compiled = compileKeymap(map({ prefix: ["ctrl+shift+8"], bindings: [
        { action: "new_tab", keys: chords.flatMap((key) => [key, `prefix+${key}`]) },
      ] }), { mac: macPlatform, overrides: {} });
      expect(compiled.direct.size).toBe(0);
      expect(compiled.prefixed.size).toBe(0);
      for (const key of [event("t", { metaKey: true }), event("v", { ctrlKey: true })]) {
        expect(resolveKey(compiled, key, { ...context, prefixUntil: 1000 }).kind).toBe("pass");
      }
    }
  });

  it("leaves an unsupported command's chord alone rather than running a default", () => {
    const compiled = compileKeymap(map({ commands: [{ key: "prefix+c", type: "shell", description: "custom" }] }), mac);
    expect(compiled.prefixed.size).toBe(0);
    expect(compiled.prefixes.size).toBe(0);
    expect(compiled.report.find((row) => row.action === "new_tab")?.status).toBe("duplicate");
  });

  it("disables all ambiguous actions and reports terminal-only actions", () => {
    const compiled = compileKeymap(map({ bindings: [
      { action: "new_tab", keys: ["prefix+c"] }, { action: "settings", keys: ["prefix+c"] },
      { action: "split_vertical", keys: ["prefix+v"] },
    ] }), mac);
    expect(compiled.prefixed.size).toBe(0);
    expect(compiled.report.filter((row) => row.status === "duplicate")).toHaveLength(2);
    expect(compiled.report.find((row) => row.action === "split_vertical")?.status).toBe("unsupported");
  });

  it("does not choose between a prefix and a command or direct binding on the same chord", () => {
    for (const patch of [
      { commands: [{ key: "cmd+shift+8", type: "shell", description: "custom" }] },
      { bindings: [{ action: "settings", keys: ["cmd+shift+8"] }] },
    ]) {
      const compiled = compileKeymap(map({ prefix: ["cmd+shift+8"], ...patch }), mac);
      expect(compiled.prefixes.size).toBe(0);
      expect(compiled.direct.size).toBe(0);
    }
  });

  it("blocks the default browser Ctrl+B outside Mac and accepts a free configured prefix", () => {
    expect(compileKeymap(map(), { mac: false, overrides: {} }).prefixes.size).toBe(0);
    const compiled = compileKeymap(map({ prefix: ["ctrl+shift+8"] }), { mac: false, overrides: {} });
    expect(resolveKey(compiled, event("*", { code: "Digit8", ctrlKey: true, shiftKey: true }), context).kind).toBe("prefix");
  });

  it("allows a free direct Mod+Shift binding without changing the web resolver", () => {
    const compiled = compileKeymap(map({ bindings: [{ action: "settings", keys: ["cmd+shift+8"] }] }), mac);
    expect(resolveKey(compiled, event("*", { code: "Digit8", metaKey: true, shiftKey: true }), context))
      .toEqual({ kind: "action", target: { action: "settings", index: null } });
  });
});

describe("prefix and native-input boundaries", () => {
  const compiled = compileKeymap(map(), mac);
  it("starts a prefix and resolves its action only within the injected deadline", () => {
    expect(resolveKey(compiled, event("b", { ctrlKey: true }), context).kind).toBe("prefix");
    expect(resolveKey(compiled, event("c"), { ...context, prefixUntil: context.now + PREFIX_TIMEOUT_MS }))
      .toEqual({ kind: "action", target: { action: "new_tab", index: null } });
    expect(resolveKey(compiled, event("c"), { ...context, now: 1600, prefixUntil: 1600 }).kind).toBe("pass");
  });

  it("keeps a prefix through the modifier keydown preceding a shifted suffix", () => {
    const shifted = compileKeymap(map({ bindings: [{ action: "new_workspace", keys: ["prefix+shift+n"] }] }), mac);
    const active = { ...context, prefixUntil: 200 };
    expect(resolveKey(shifted, event("Shift", { shiftKey: true }), active).kind).toBe("ignore");
    expect(resolveKey(shifted, event("N", { shiftKey: true }), active))
      .toEqual({ kind: "action", target: { action: "new_workspace", index: null } });
  });

  for (const guard of ["inTextField", "modalOpen", "composing"] as const) it(`leaves native input alone when ${guard}`, () => {
    expect(resolveKey(compiled, event("c"), { ...context, prefixUntil: 200, [guard]: true }).kind).toBe("pass");
    expect(resolveKey(compiled, event("b", { ctrlKey: true }), { ...context, [guard]: true }).kind).toBe("pass");
  });

  it("cannot act while disabled, disconnected or observing", () => {
    expect(resolveKey(compiled, event("c"), { ...context, prefixUntil: 200, enabled: false }).kind).toBe("pass");
  });

  it("does not consume repeats, already handled keys, IME or dead keys", () => {
    for (const key of [{ ...event("c"), repeat: true }, { ...event("c"), defaultPrevented: true },
      event("c", { isComposing: true }), event("c", { keyCode: 229 }), event("Dead")]) {
      expect(resolveKey(compiled, key, { ...context, prefixUntil: 200 }).kind).toBe("pass");
    }
  });

  it("cancels Escape but passes an unsupported suffix or browser chord", () => {
    expect(resolveKey(compiled, event("Escape"), { ...context, prefixUntil: 200 }).kind).toBe("cancel");
    expect(resolveKey(compiled, event("v"), { ...context, prefixUntil: 200 }).kind).toBe("pass");
    expect(resolveKey(compiled, event("c", { metaKey: true }), { ...context, prefixUntil: 200 }).kind).toBe("pass");
  });

  it("expands one-based indexed bindings and rejects a missing index", () => {
    const indexed = compileKeymap(map({ bindings: [
      { action: "switch_tab", keys: ["prefix+1..9"] }, { action: "focus_agent", keys: ["prefix+f"] },
    ] }), mac);
    expect(resolveKey(indexed, event("9"), { ...context, prefixUntil: 200 }))
      .toEqual({ kind: "action", target: { action: "switch_tab", index: 9 } });
    expect(indexed.report.find((row) => row.action === "focus_agent")?.status).toBe("invalid");
  });
});

describe("Herdr chord syntax", () => {
  it("normalizes named punctuation and shift without dropping modifiers", () => {
    expect(parseBinding("prefix+?")).toEqual(parseBinding("prefix+shift+slash"));
    expect(parseBinding("ctrl++")).toEqual(parseBinding("ctrl+shift+equal"));
    expect(parseBinding("prefix+shift+tab")?.chords[0]?.chord.key).toBe("Tab");
    for (const text of ["", "prefix+", "ctrl+unknown", "hyper+c", "constructor", "ctrl+constructor"]) expect(parseBinding(text)).toBeNull();
  });

  it("keeps Latin layout letters and supports non-Latin physical positions", () => {
    const korean = chordOfEvent(event("ㅠ", { code: "KeyB", ctrlKey: true }));
    expect(korean).toEqual({ key: "b", ctrl: true, alt: false, shift: false, meta: false });
    expect(chordOfEvent(event("é", { code: "KeyB", ctrlKey: true }))?.key).toBe("é");
    expect(chordOfEvent(event("q", { code: "KeyB", ctrlKey: true }))?.key).toBe("q");
  });
});
