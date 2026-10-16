/** Explicit reviewed deviations from mapTheme. Add alongside the CSS edit, never generate. */
import { normalizeThemeValue, parseThemeBlocks } from "../src/lib/themeCss.ts";
import { ROLES, SUPPORTED_ENTRIES } from "../src/lib/themes.ts";
import type { Mode } from "../src/lib/themes.ts";
import baseline from "../src/lib/themes.legacy-baseline.json";
import { isHerdrThemeId, KIND } from "./herdr-themes.ts";
import type { HerdrThemeId } from "./herdr-themes.ts";
import { mapTheme } from "./herdr-theme-proposal.ts";
import type { Role } from "./herdr-theme-proposal.ts";

export type ThemeOverride = {
  readonly theme: HerdrThemeId;
  readonly mode: Mode;
  readonly role: Role;
  readonly value: string;
  readonly dE: number;
  readonly reason: string;
};

export const OVERRIDES: readonly ThemeOverride[] = [];

/** Pure policy used by the test and by temporary-copy QA. A diagnostic always names entry/role. */
export function provenanceFailures(
  css: string,
  entries: readonly { readonly id: string; readonly mode: Mode }[] = SUPPORTED_ENTRIES,
  overrides: readonly ThemeOverride[] = OVERRIDES,
): string[] {
  const blocks = parseThemeBlocks(css), failures: string[] = [];
  const legacy = new Set([...Object.keys(baseline.combos), "catppuccin-latte/light"]);
  for (const { id, mode } of entries) {
    const key = `${id}/${mode}`;
    if (legacy.has(key)) continue;
    if (!isHerdrThemeId(id) || KIND[id] !== mode) {
      failures.push(`${key}: no pinned herdr palette of this kind`);
      continue;
    }
    const mapped = mapTheme(id);
    for (const role of Object.keys(ROLES)) {
      const expected = mapped[role as Role], actual = blocks[key]?.declared[`--${role}`];
      const override = overrides.find((item) => item.theme === id && item.mode === mode && item.role === role);
      if (actual === undefined || (actual !== normalizeThemeValue(expected) && !override)) {
        failures.push(`${key} ${role}: ${actual ?? "(missing)"} differs from mapped ${expected} without override`);
      }
    }
  }
  const seen = new Set<string>();
  for (const item of overrides) {
    const key = `${item.theme}/${item.mode}`, label = `${key} ${item.role}`;
    const actual = blocks[key]?.declared[`--${item.role}`];
    if (seen.has(label)) failures.push(`${label}: duplicate override`);
    seen.add(label);
    if (!entries.some((entry) => entry.id === item.theme && entry.mode === item.mode) || legacy.has(key)
      || actual === undefined || actual !== normalizeThemeValue(item.value)) failures.push(`${label}: stale override`);
    if (!Number.isFinite(item.dE) || item.dE < 0 || !item.reason.trim()) failures.push(`${label}: override needs finite dE and reason`);
    if (normalizeThemeValue(item.value) === normalizeThemeValue(mapTheme(item.theme)[item.role])) failures.push(`${label}: redundant override`);
  }
  return failures;
}
