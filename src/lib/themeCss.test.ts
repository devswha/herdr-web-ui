import { expect, it } from "bun:test";
import { normalizeThemeValue } from "./themeCss.ts";

it("spells a theme value one way: collapsed spaces, lowercase hex, rgba() with spaced arguments and no trailing zeros", () => {
  expect(normalizeThemeValue("  #DCD4C6 ")).toBe("#dcd4c6");
  expect(normalizeThemeValue("rgba(240,168,48,0.130)")).toBe("rgba(240, 168, 48, 0.13)");
  expect(normalizeThemeValue("0 16px\n    48px RGBA(40, 32, 22, .16),  0 0 0 1px var(--border)")).toBe("0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)");
  expect(normalizeThemeValue("var(--Border)")).toBe("var(--Border)");
});
