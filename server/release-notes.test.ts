import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SUMMARY_LANGUAGES } from "../shared/update.ts";
import { compareVersions, releaseNotes, releaseSummaries, SUMMARIES_FILE, SUMMARY_LIMIT } from "./release-notes.ts";

const CHANGELOG = `# Changelog

Each release is a \`vX.Y.Z\` Git tag.

## [Unreleased]

### Added
- Not in any release yet.

## [0.4.0] - 2026-10-07

### Added
- A wrapped entry that goes on
  to a second line. ([#9](https://example.invalid/pull/9))

### Fixed
- A fix.

## [0.3.10] - 2026-10-06

### Changed
- Ten comes after nine.

## [0.3.9] - 2026-10-05

### Fixed
- Nine.

## [0.3.8]

## [0.3.7] - 2026-10-03

First of the line.

[Unreleased]: https://example.invalid/compare/v0.4.0...HEAD
[0.4.0]: https://example.invalid/compare/v0.3.10...v0.4.0
`;

describe("release notes of an update", () => {
  it("tells the one release an update brings, without its heading", () => {
    expect(releaseNotes(CHANGELOG, "0.3.10", "0.4.0")).toEqual({
      releases: [{ version: "0.4.0", date: "2026-10-07", notes:
        "### Added\n- A wrapped entry that goes on\n  to a second line. ([#9](https://example.invalid/pull/9))\n\n### Fixed\n- A fix." }],
      omitted: 0,
    });
  });

  it("tells every release that was skipped, newest first, comparing versions as numbers", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.8", "0.4.0");
    expect(notes.releases.map((release) => release.version)).toEqual(["0.4.0", "0.3.10", "0.3.9"]);
    expect(notes.omitted).toBe(0);
  });

  it("stops at the release the update installs: nothing unreleased, nothing newer", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.3.10");
    expect(notes.releases.map((release) => release.version)).toEqual(["0.3.10", "0.3.9"]);
    expect(JSON.stringify(notes)).not.toContain("Not in any release yet");
  });

  it("leaves out a release whose section is empty, and the compare links under the last one", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.6", "0.3.8");
    expect(notes.releases).toEqual([{ version: "0.3.7", date: "2026-10-03", notes: "First of the line." }]);
  });

  it("keeps a heading of its own level inside a release: only a release or Unreleased ends a section", () => {
    const log = "## [Unreleased]\n\n## Planned\n- Not yet.\n\n## [0.4.0] - 2026-10-07\n\n### Changed\n- A change.\n\n## Migration\n\nRun the thing.\n\n## [0.3.9]\n- Nine.\n";
    expect(releaseNotes(log, "0.3.9", "0.4.0").releases).toEqual([
      { version: "0.4.0", date: "2026-10-07", notes: "### Changed\n- A change.\n\n## Migration\n\nRun the thing." },
    ]);
  });

  it("keeps a linked heading that names no release, and ends at a release it cannot read", () => {
    const log = "## [0.4.0] - 2026-10-07\nBefore.\n\n## [Migration](https://example.com/migrate)\nRun the thing.\n\n## [0.4.0-rc.1] - 2026-10-01\nA candidate.\n\n## [0.3.9](https://example.com/v0.3.9)\nNine.\n";
    expect(releaseNotes(log, "0.3.8", "0.4.0").releases).toEqual([
      { version: "0.4.0", date: "2026-10-07", notes: "Before.\n\n## [Migration](https://example.com/migrate)\nRun the thing." },
    ]);
  });

  it("tells the latest release alone when the running version is unknown", () => {
    expect(releaseNotes(CHANGELOG, null, "0.3.10").releases.map((release) => release.version)).toEqual(["0.3.10"]);
    expect(releaseNotes(CHANGELOG, "main", "0.3.10").releases.map((release) => release.version)).toEqual(["0.3.10"]);
  });

  it("has nothing for a release the changelog does not name, or a tag that is no version", () => {
    expect(releaseNotes(CHANGELOG, "0.4.0", "0.4.1")).toEqual({ releases: [], omitted: 0 });
    expect(releaseNotes(CHANGELOG, "0.3.9", "nightly")).toEqual({ releases: [], omitted: 0 });
    expect(releaseNotes("", "0.3.9", "0.4.0")).toEqual({ releases: [], omitted: 0 });
  });

  it("counts the older releases a long jump leaves out", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.4.0", 160);
    expect(notes.releases.map((release) => release.version)).toEqual(["0.4.0", "0.3.10"]);
    expect(notes.omitted).toBe(1);
  });

  it("cuts the newest release at a line when it alone is over the budget", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.4.0", 40);
    expect(notes.releases).toEqual([{ version: "0.4.0", date: "2026-10-07", notes: "### Added\n- A wrapped entry that goes on\n\n…" }]);
    expect(notes.omitted).toBe(2);
  });
});

describe("a release told in a few sentences", () => {
  const written = JSON.stringify({
    "0.4.0": { en: "  Four, in short.  ", ko: "넷을 짧게.", ja: "", fr: "Quatre." },
    "0.3.10": { en: "Ten, in short." },
    "0.3.9": "nine",
    "next": { en: "No version." },
    "0.3.8": { en: 8 },
  });

  it("reads the summaries of each release, in the languages the app has", () => {
    expect([...releaseSummaries(written)]).toEqual([
      ["0.4.0", { en: "Four, in short.", ko: "넷을 짧게." }],
      ["0.3.10", { en: "Ten, in short." }],
    ]);
  });

  it("has none in a file that is not an object of releases", () => {
    for (const text of ["", "not json", "[]", "null", "7", '"0.4.0"']) expect(releaseSummaries(text).size).toBe(0);
  });

  it("cuts a summary that is no summary", () => {
    const told = releaseSummaries(JSON.stringify({ "0.4.0": { en: "a".repeat(SUMMARY_LIMIT + 500) } })).get("0.4.0")!.en!;
    expect(told).toHaveLength(SUMMARY_LIMIT + 1);
    expect(told.endsWith("…")).toBe(true);
  });

  it("puts a release's summary beside its notes, and leaves a release without one as it was", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.8", "0.4.0", undefined, releaseSummaries(written));
    expect(notes.releases.map((release) => [release.version, release.summary])).toEqual([
      ["0.4.0", { en: "Four, in short.", ko: "넷을 짧게." }],
      ["0.3.10", { en: "Ten, in short." }],
      ["0.3.9", undefined],
    ]);
    expect("summary" in notes.releases[2]!).toBe(false);
  });

  it("compares versions as numbers, and not what is no version", () => {
    expect(compareVersions("0.3.10", "0.3.9")! > 0).toBe(true);
    expect(compareVersions("0.3.9", "0.3.9")).toBe(0);
    expect(compareVersions("0.3.9", "1.0.0")! < 0).toBe(true);
    expect(compareVersions("0.3.9", "main")).toBeNull();
  });
});

describe("this repository's own summaries", () => {
  const root = join(import.meta.dir, "..");
  const summaries = releaseSummaries(readFileSync(join(root, SUMMARIES_FILE), "utf8"));
  const released = [...readFileSync(join(root, "CHANGELOG.md"), "utf8").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]!);
  /** the last release cut before summaries were written */
  const BEFORE = "0.3.52";

  it("tells every release since in all four languages", () => {
    const missing = released.filter((version) => compareVersions(version, BEFORE)! > 0)
      .flatMap((version) => SUMMARY_LANGUAGES.filter((language) => !summaries.get(version)?.[language]).map((language) => `${version} ${language}`));
    expect(missing).toEqual([]);
  });

  it("holds nothing but whole summaries of releases the changelog names", () => {
    const raw = JSON.parse(readFileSync(join(root, SUMMARIES_FILE), "utf8")) as Record<string, Record<string, string>>;
    for (const [version, entry] of Object.entries(raw)) {
      expect(released).toContain(version);
      expect(Object.keys(entry).sort()).toEqual([...SUMMARY_LANGUAGES].sort());
      for (const told of Object.values(entry)) {
        expect(told.trim()).toBe(told);
        expect(told.length).toBeGreaterThan(0);
        expect(told.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
      }
    }
  });
});
