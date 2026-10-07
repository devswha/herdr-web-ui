/** What an update brings, read from the CHANGELOG.md of the release it installs. */
import type { ReleaseNote, UpdateNotes } from "../shared/update.ts";

/** `## [0.3.52] - 2026-10-06`; `## [Unreleased]` is no release. */
const SECTION = /^## \[(\d+\.\d+\.\d+)\](?:\s+-\s+(\S+))?\s*$/;
/** `[0.3.52]: https://…`, the compare links under the last section */
/** Where a section ends: the heading of any release (a pre-release, a linked one) or of Unreleased. */
const BOUNDARY = /^## \[(?:unreleased|\d+\.\d+\.\d+[^\]]*)\]/i;
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;
/**
 * Notes are read in a Settings box, not as the whole history: a jump over many releases names
 * the rest by count. Characters, since it bounds what is read, not what is sent.
 */
export const NOTES_BUDGET = 48_000;

function triple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Positive when `a` is the later version. */
function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function sections(changelog: string): ReleaseNote[] {
  const found: ReleaseNote[] = [];
  let open: { version: string; date: string | null; lines: string[] } | null = null;
  const close = () => {
    if (open) found.push({ version: open.version, date: open.date, notes: open.lines.join("\n").trim() });
    open = null;
  };
  for (const line of changelog.split(/\r?\n/)) {
    // a release or Unreleased opens the next section; another level-two heading (`## Migration`,
    // `## [Migration](https://…)`) belongs to the notes
    if (BOUNDARY.test(line)) {
      close();
      const match = SECTION.exec(line);
      if (match) open = { version: match[1]!, date: match[2] ?? null, lines: [] };
    } else if (open && !LINK_DEFINITION.test(line)) open.lines.push(line);
  }
  close();
  return found;
}

/**
 * The sections of every release after `current`, up to `latest`, newest first. With no known
 * running version, the latest release alone. A release without a section, or with an empty one,
 * is left out.
 */
export function releaseNotes(changelog: string, current: string | null, latest: string, budget = NOTES_BUDGET): Omit<UpdateNotes, "revision"> {
  const to = triple(latest);
  if (!to) return { releases: [], omitted: 0 };
  const from = current === null ? null : triple(current);
  const wanted = sections(changelog)
    .filter((section) => {
      const version = triple(section.version)!;
      if (section.notes === "" || compare(version, to) > 0) return false;
      return from ? compare(version, from) > 0 : compare(version, to) === 0;
    })
    .sort((a, b) => compare(triple(b.version)!, triple(a.version)!));
  const releases: ReleaseNote[] = [];
  let used = 0;
  for (const section of wanted) {
    // the newest release is always told, cut at a line when it alone is over the budget
    if (releases.length === 0 && section.notes.length > budget) {
      const cut = section.notes.lastIndexOf("\n", budget);
      releases.push({ ...section, notes: `${section.notes.slice(0, cut > 0 ? cut : budget).trimEnd()}\n\n…` });
      break;
    }
    if (used + section.notes.length > budget) break;
    releases.push(section);
    used += section.notes.length;
  }
  return { releases, omitted: wanted.length - releases.length };
}
