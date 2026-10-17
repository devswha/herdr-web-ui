/** The authored theme role contract. Theme values live only in src/styles.css. */
import { SUPPORTED_ENTRIES, THEME_IDS } from "./themes.generated.ts";
import type { ThemeId } from "./themes.generated.ts";

export { SUPPORTED_ENTRIES, THEME_IDS };
export { ROLES, SHADOW_GEOMETRY } from "./themeRoles.ts";
export type { ThemeId };

export type Mode = "dark" | "light";

export type ThemeEntry = (typeof SUPPORTED_ENTRIES)[number];

export type TerminalColors = { readonly background: string; readonly foreground: string; readonly cursor: string; readonly selectionBackground: string };

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

const AMBER: Record<Mode, ThemeEntry> = {
  dark: SUPPORTED_ENTRIES.find((entry) => entry.id === "amber" && entry.mode === "dark")!,
  light: SUPPORTED_ENTRIES.find((entry) => entry.id === "amber" && entry.mode === "light")!,
};

/** The row drawn for a side: a both-mode theme's row of that side, a single-kind theme's only row, amber for an unknown id. */
export function rowFor(id: string, side: Mode): ThemeEntry {
  const rows = SUPPORTED_ENTRIES.filter((entry) => entry.id === id);
  return rows.find((entry) => entry.mode === side) ?? (rows.length === 1 ? rows[0] : undefined) ?? AMBER[side];
}

/** `<meta name="theme-color">`: the panel surface of the row drawn for `mode`. */
export function themeColor(id: string, mode: Mode): string {
  return rowFor(id, mode).bgPanel;
}

/** The xterm colors of the row drawn for `mode`: its `--term-*` tokens. */
export function terminalColors(id: string, mode: Mode): TerminalColors {
  return rowFor(id, mode).terminal;
}

export const HERDR_SOURCE = {
  repo: "herdrdev/herdr",
  sha: "143bf5fd4781d164260c63fe28e7dc08054ad32f",
} as const;
