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

export const OVERRIDES: readonly ThemeOverride[] = [
  {"theme":"tokyo-night","mode":"dark","role":"status-blocked","value":"#fc7a92","dE":1.3369569501082346,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night","mode":"dark","role":"status-blocked-tint","value":"rgba(252, 122, 146, 0.14)","dE":1.3369569501082346,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night","mode":"dark","role":"danger-tint","value":"rgba(252, 122, 146, 0.12)","dE":1.3369569501082346,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night","mode":"dark","role":"danger-text","value":"#fc7a92","dE":1.3369569501082346,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"text","value":"#274dab","dE":6.184709819612932,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"text-dim","value":"#41508a","dE":11.806672082387482,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"text-strong","value":"#274dab","dE":6.184709819612932,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"primary-hover","value":"#2e78e3","dE":0.6197819267758081,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-working","value":"#0040a7","dE":18.99253368509796,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-blocked","value":"#90001b","dE":23.409147285585878,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-done","value":"#365013","dE":12.849764438778635,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-working-tint","value":"rgba(0, 64, 167, 0.12)","dE":18.99253368509796,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-blocked-tint","value":"rgba(144, 0, 27, 0.12)","dE":23.409147285585878,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"status-done-tint","value":"rgba(54, 80, 19, 0.12)","dE":12.849764438778635,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"danger-tint","value":"rgba(144, 0, 27, 0.1)","dE":23.409147285585878,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"danger-text","value":"#90001b","dE":23.409147285585878,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"scrim","value":"rgba(39, 77, 171, 0.35)","dE":6.184709819612932,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"line-number","value":"#41508a","dE":11.806672082387482,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-function","value":"#004db6","dE":14.938859565334011,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-keyword","value":"#6937ac","dE":5.152763893804094,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-string","value":"#405b1f","dE":8.95277181503446,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-number","value":"#8c3b00","dE":11.25049081276345,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-type","value":"#6c4d1f","dE":10.845273221210743,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-variable","value":"#274dab","dE":6.184709819612932,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"syntax-meta","value":"#005f4a","dE":14.235514439126485,"reason":"AA lightness repair on serialized hex (target 4.6; chroma reduction at most 5%)"},
  {"theme":"tokyo-night-day","mode":"light","role":"shadow-drawer","value":"0 0 40px rgba(39, 77, 171, 0.22)","dE":6.184709819612932,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"shadow-pop","value":"0 16px 48px rgba(39, 77, 171, 0.16), 0 0 0 1px var(--border)","dE":6.184709819612932,"reason":"Recomputed default from AA-repaired foreground"},
  {"theme":"tokyo-night-day","mode":"light","role":"shadow-card","value":"0 4px 16px rgba(39, 77, 171, 0.07)","dE":6.184709819612932,"reason":"Recomputed default from AA-repaired foreground"},
];

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
