import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEntry } from "./themeCss.ts";
import { DEFAULT_THEME, isThemeId, pickTheme, rowFor, SUPPORTED_ENTRIES, terminalColors, THEME_IDS, themeColor } from "./themes.ts";

describe("theme lookups", () => {
  it("keeps OLED surfaces exactly black, with warm selection and one dark row on either side", () => {
    expect(isThemeId("oled")).toBe(true);
    expect(SUPPORTED_ENTRIES.filter(({ id }) => id === "oled").map(({ mode }) => mode)).toEqual(["dark"]);
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const { resolved } = resolveEntry(css, "oled", "dark");
    for (const role of ["bg", "bg-panel", "bg-elevated", "bg-input", "term-bg"]) {
      expect({ role, color: resolved[`--${role}`] }).toEqual({ role, color: "#000000" });
    }
    for (const side of ["dark", "light"] as const) {
      expect(rowFor("oled", side)).toMatchObject({ id: "oled", mode: "dark" });
      expect(themeColor("oled", side)).toBe("#000000");
      expect(terminalColors("oled", side)).toEqual({
        background: "#000000", foreground: "#d4d4d4", cursor: "#f0932b", selectionBackground: "#2b1908",
      });
    }
    const globalDark = resolveEntry(css, "amber", "dark").resolved;
    for (const state of ["working", "blocked", "done", "idle", "unknown"]) {
      const role = `--indicator-${state}`;
      expect({ role, color: resolved[role] }).toEqual({ role, color: globalDark[role] });
    }
    expect(resolved["--syntax-comment"]).toBe(resolved["--text-dim"]);
    expect(resolved["--syntax-inserted"]).toBe(resolved["--status-done"]);
    expect(resolved["--syntax-deleted"]).toBe(resolved["--status-blocked"]);
    expect(resolved["--accent-tint"]).toBe("#2b1908");
    expect(pickTheme({ darkTheme: "codex", lightTheme: "codex" }, "dark", "oled")).toEqual({ darkTheme: "oled" });
  });

  it("knows the ids of the generated table and nothing else", () => {
    expect(THEME_IDS.every((id) => isThemeId(id))).toBe(true);
    expect([isThemeId("not-a-theme"), isThemeId(""), isThemeId(undefined), isThemeId(1)]).toEqual([false, false, false, false]);
  });

  it("draws a both-mode theme's row of each side", () => {
    for (const side of ["dark", "light"] as const) {
      const row = rowFor("charcoal", side);
      expect([row.id, row.mode]).toEqual(["charcoal", side]);
    }
  });

  it("falls back to the default theme of the same side for an unknown id", () => {
    for (const side of ["dark", "light"] as const) {
      expect(rowFor("not-a-theme", side)).toBe(rowFor(DEFAULT_THEME, side));
      expect(rowFor("not-a-theme", side).mode).toBe(side);
    }
  });

  it("reads theme-color and terminal colors from the row of the side", () => {
    for (const entry of SUPPORTED_ENTRIES) {
      expect(themeColor(entry.id, entry.mode)).toBe(entry.bgPanel);
      expect(terminalColors(entry.id, entry.mode)).toEqual(entry.terminal);
    }
    expect(themeColor("amber", "dark")).toBe("#181613");
    expect(terminalColors("catppuccin", "light").background).toBe("#eff1f5");
  });
});

describe("picking a theme", () => {
  it("fills the other side with the sibling while that side is the default or the previous pick's sibling", () => {
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "dark", "tokyo-night")).toEqual({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" });
    // codex is the default, and amber, the default before it, is as unchosen
    expect(pickTheme({ darkTheme: "codex", lightTheme: "codex" }, "dark", "tokyo-night")).toEqual({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" });
    expect(pickTheme({ darkTheme: "codex", lightTheme: "amber" }, "light", "catppuccin-latte")).toEqual({ darkTheme: "catppuccin", lightTheme: "catppuccin-latte" });
    expect(pickTheme({ darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox", lightTheme: "gruvbox-light" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "light", "catppuccin-latte")).toEqual({ darkTheme: "catppuccin", lightTheme: "catppuccin-latte" });
  });

  it("keeps a side the user chose, and fills nothing for a theme without a pair or picked for its own kind's other side", () => {
    expect(pickTheme({ darkTheme: "tokyo-night", lightTheme: "charcoal" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "tokyo-night-day" }, "dark", "gruvbox")).toEqual({ darkTheme: "gruvbox" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "dark", "charcoal")).toEqual({ darkTheme: "charcoal" });
    expect(pickTheme({ darkTheme: "amber", lightTheme: "amber" }, "light", "tokyo-night")).toEqual({ lightTheme: "tokyo-night" });
  });
});
