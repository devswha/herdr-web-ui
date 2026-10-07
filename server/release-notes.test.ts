import { describe, expect, it } from "bun:test";
import { releaseNotes } from "./release-notes.ts";

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
