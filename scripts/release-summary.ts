/** The languages a release's summary is written in: the app's own (src/lib/i18n.ts). */
export const SUMMARY_LANGUAGES = ["en", "ko", "ja", "zh"] as const;
export type SummaryLanguage = typeof SUMMARY_LANGUAGES[number];
/** The lists a summary is told in, in the order they are read. */
export const SUMMARY_GROUPS = ["new", "improved", "fixed"] as const;
export type SummaryGroup = typeof SUMMARY_GROUPS[number];
/** A release as patch notes: short lines of plain text under what is new, improved and fixed. A list with no line is absent. */
export type ReleaseHighlights = Partial<Record<SummaryGroup, string[]>>;
/** A release's highlights per language; a language the release did not write is absent. */
export type ReleaseSummary = Partial<Record<SummaryLanguage, ReleaseHighlights>>;
/** A highlight is one line, and a list a handful of them: what is longer is cut where it is read. */
export const HIGHLIGHT_LIMIT = 160;
export const HIGHLIGHTS_PER_GROUP = 8;

export function readSummary(value: unknown): ReleaseSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const summary: ReleaseSummary = {};
  for (const language of SUMMARY_LANGUAGES) {
    const written: unknown = (value as Record<string, unknown>)[language];
    if (typeof written !== "object" || written === null) continue;
    const highlights: ReleaseHighlights = {};
    for (const group of SUMMARY_GROUPS) {
      const lines: unknown = (written as Record<string, unknown>)[group];
      if (!Array.isArray(lines)) continue;
      const kept = lines.filter((line): line is string => typeof line === "string" && line.trim() !== "")
        .slice(0, HIGHLIGHTS_PER_GROUP)
        .map((line) => line.trim())
        .map((line) => line.length > HIGHLIGHT_LIMIT ? `${line.slice(0, HIGHLIGHT_LIMIT).trimEnd()}…` : line);
      if (kept.length > 0) highlights[group] = kept;
    }
    if (Object.keys(highlights).length > 0) summary[language] = highlights;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}


export const SUMMARIES_FILE = "release-summaries.json";
export function releaseSummaries(text: string): Map<string, ReleaseSummary> {
  const found = new Map<string, ReleaseSummary>();
  let written: unknown;
  try { written = JSON.parse(text); } catch { return found; }
  if (typeof written !== "object" || written === null || Array.isArray(written)) return found;
  for (const [version, entry] of Object.entries(written)) {
    const summary = /^\d+\.\d+\.\d+$/.test(version) ? readSummary(entry) : undefined;
    if (summary) found.set(version, summary);
  }
  return found;
}
