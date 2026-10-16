/** The authored theme role contract. Theme values live only in src/styles.css. */
import { SUPPORTED_ENTRIES, THEME_IDS } from "./themes.generated.ts";
import type { ThemeId } from "./themes.generated.ts";

export { SUPPORTED_ENTRIES, THEME_IDS };
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

const SIBLING_PAIRS: readonly (readonly [dark: ThemeId, light: ThemeId])[] = [
  ["catppuccin", "catppuccin-latte"],
  ["tokyo-night", "tokyo-night-day"],
  ["gruvbox", "gruvbox-light"],
  ["one-dark", "one-light"],
  ["solarized", "solarized-light"],
  ["kanagawa", "kanagawa-lotus"],
  ["rose-pine", "rose-pine-dawn"],
];

/** Only a known pair's opposite side is pre-filled; same-side picks have no sibling. */
export function siblingFor(id: string, targetSide: Mode): ThemeId | undefined {
  const pair = SIBLING_PAIRS.find(([dark, light]) => targetSide === "light" ? id === dark : id === light);
  return pair?.[targetSide === "light" ? 1 : 0];
}

/** The theme either side starts from, and falls back to for an unknown id. */
export const DEFAULT_THEME: ThemeId = "amber";

const SIDE_KEY = { dark: "darkTheme", light: "lightTheme" } as const;

/**
 * What picking `id` for `side` changes: that side, and the other side too when `id` has a
 * sibling and the other side was never chosen on its own - still the default, or the sibling the
 * previous pick put there. A side the user chose keeps its theme.
 */
export function pickTheme(current: { readonly darkTheme: string; readonly lightTheme: string }, side: Mode, id: ThemeId): Partial<Record<"darkTheme" | "lightTheme", ThemeId>> {
  const other: Mode = side === "dark" ? "light" : "dark";
  const sibling = siblingFor(id, other);
  const untouched = current[SIDE_KEY[other]] === DEFAULT_THEME || current[SIDE_KEY[other]] === siblingFor(current[SIDE_KEY[side]], other);
  return sibling !== undefined && untouched ? { [SIDE_KEY[side]]: id, [SIDE_KEY[other]]: sibling } : { [SIDE_KEY[side]]: id };
}

export const ROLES = {
  bg: "color",
  "bg-panel": "color",
  "bg-elevated": "color",
  "bg-hover": "color",
  "bg-input": "color",
  border: "color",
  "border-strong": "color",
  text: "color",
  "text-dim": "color",
  "text-strong": "color",
  accent: "color",
  "accent-tint": "color",
  primary: "color",
  "primary-hover": "color",
  "primary-text": "color",
  "primary-tint": "color",
  "status-idle": "color",
  "status-working": "color",
  "status-blocked": "color",
  "status-done": "color",
  "status-working-tint": "color",
  "status-blocked-tint": "color",
  "status-done-tint": "color",
  "danger-tint": "color",
  notice: "color",
  "danger-text": "color",
  scrim: "color",
  "term-bg": "color",
  "term-fg": "color",
  "term-cursor": "color",
  "term-selection": "color",
  "line-number": "color",
  "syntax-function": "color",
  "syntax-keyword": "color",
  "syntax-string": "color",
  "syntax-number": "color",
  "syntax-type": "color",
  "syntax-variable": "color",
  "syntax-meta": "color",
  "bubble-border": "color",
  "shadow-drawer": "shadow",
  "shadow-pop": "shadow",
  "shadow-card": "shadow",
} as const;

export const SHADOW_GEOMETRY = {
  dark: {
    "shadow-drawer": ["0 0 40px"],
    "shadow-pop": ["0 16px 48px", "0 0 0 1px"],
    "shadow-card": ["0 4px 16px"],
  },
  light: {
    "shadow-drawer": ["0 0 40px"],
    "shadow-pop": ["0 16px 48px", "0 0 0 1px"],
    "shadow-card": ["0 4px 16px"],
  },
} as const;

export const HERDR_SOURCE = {
  repo: "herdrdev/herdr",
  sha: "143bf5fd4781d164260c63fe28e7dc08054ad32f",
} as const;
