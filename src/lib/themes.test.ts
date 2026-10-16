import { describe, expect, it } from "bun:test";
import { isThemeId, rowFor, SUPPORTED_ENTRIES, terminalColors, THEME_IDS, themeColor } from "./themes.ts";

describe("theme lookups", () => {
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

  it("falls back to amber of the same side for an unknown id", () => {
    for (const side of ["dark", "light"] as const) {
      expect(rowFor("not-a-theme", side)).toBe(rowFor("amber", side));
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
