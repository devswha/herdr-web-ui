import { describe, expect, it } from "bun:test";
import { readInstalledNotes, readUpdateNotes, SUMMARY_LANGUAGES, type InstalledNotes, type UpdateNotes } from "../../shared/update.ts";
import { ApiError } from "./api.ts";
import { LANGUAGE_SETTINGS } from "./i18n.ts";
import { ANNOUNCED_FOR_MS, announcesUpdate, installedUpdate, notesOffer, notesRetryDelay, notesUnboundDelay, offeredNotes, summaryFor } from "./updateNotes.ts";

const offered = { current_revision: "a".repeat(40), latest_revision: "b".repeat(40), current_version: "0.3.9", latest_version: "0.4.0" };
const notes: UpdateNotes = { revision: offered.latest_revision, releases: [{ version: "0.4.0", date: "2026-10-07", notes: "### Added\n- A thing." }], omitted: 0 };

describe("notes beside an offered update", () => {
  it("shows the notes read from the commit the status offers", () => {
    expect(offeredNotes(offered, notes)).toBe(notes);
  });

  it("shows nothing before a status, before the notes, or for a release without any", () => {
    expect(offeredNotes(null, notes)).toBeNull();
    expect(offeredNotes(offered, null)).toBeNull();
    expect(offeredNotes(offered, { ...notes, releases: [] })).toBeNull();
  });

  it("drops notes read for another commit: a newer release, or the same tag moved", () => {
    expect(offeredNotes({ ...offered, latest_revision: "c".repeat(40) }, notes)).toBeNull();
    expect(offeredNotes(offered, { ...notes, revision: null })).toBeNull();
  });

  it("keeps the skipped releases' notes when the newest release has none of its own", () => {
    const skipped: UpdateNotes = { ...notes, releases: [{ version: "0.3.9", date: null, notes: "### Fixed\n- Nine." }] };
    expect(offeredNotes(offered, skipped)).toBe(skipped);
  });

  it("drops the notes once the release is installed", () => {
    expect(offeredNotes({ ...offered, current_revision: offered.latest_revision }, notes)).toBeNull();
    expect(offeredNotes({ ...offered, latest_revision: null }, notes)).toBeNull();
  });
});

describe("what the notes are asked for", () => {
  it("is nothing without an offer", () => {
    expect(notesOffer(null)).toBeNull();
    expect(notesOffer({ ...offered, latest_revision: null })).toBeNull();
    expect(notesOffer({ ...offered, current_revision: offered.latest_revision })).toBeNull();
  });

  it("stays the same from one status to the next of the same offer", () => {
    expect(notesOffer({ ...offered })).toBe(notesOffer(offered)!);
  });

  it("is another when the commit, the release's version or the running build moves", () => {
    const keys = [offered,
      { ...offered, latest_revision: "c".repeat(40) },
      // a second tag on the same commit: its changelog has both sections
      { ...offered, latest_version: "0.5.0" },
      // an older build restored under the same offer: one more release lies between
      { ...offered, current_revision: "d".repeat(40), current_version: "0.3.8" },
      { ...offered, current_version: null }].map(notesOffer);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(null);
  });
});

describe("asking for the notes again", () => {
  it("asks again for an answer that is not the offered commit's, about a minute long, then leaves it", () => {
    expect([0, 1, 2, 3, 4].map(notesUnboundDelay)).toEqual([2000, 4000, 8000, 16000, 30000]);
    expect(notesUnboundDelay(5)).toBeNull();
    expect(notesUnboundDelay(50)).toBeNull();
  });

  it("retries a dropped connection or a failing server, more slowly each time, up to half a minute", () => {
    const delays = [0, 1, 2, 3, 4, 50].map((attempt) => notesRetryDelay(new TypeError("Failed to fetch"), attempt));
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(notesRetryDelay(new ApiError("/api/updates/notes", 502, "Bad Gateway", null), 0)).toBe(2000);
  });

  it("does not ask a server that refuses the request itself: one older than the notes", () => {
    expect(notesRetryDelay(new ApiError("/api/updates/notes", 405, "Use GET /api/updates", "method_not_allowed"), 0)).toBeNull();
    expect(notesRetryDelay(new ApiError("/api/updates/notes", 404, "Not found", "not_found"), 3)).toBeNull();
  });
});

describe("notes as they arrive", () => {
  it("takes notes in shape as they are", () => {
    expect(readUpdateNotes(JSON.parse(JSON.stringify({ ...notes, omitted: 2 })))).toEqual({ ...notes, omitted: 2 });
  });

  it("reads anything out of shape as no notes", () => {
    const none = { revision: null, releases: [], omitted: 0 };
    for (const value of [undefined, null, "notes", 7, {}, { releases: "all" },
      { releases: [{ version: "0.4.0", date: null, notes: 42 }] },
      { releases: [{ version: 4, date: null, notes: "text" }] },
      { releases: [{ version: "0.4.0", date: 20261007, notes: "text" }] },
      { releases: [null] },
      { releases: [notes.releases[0], { version: "0.3.9" }] }]) {
      expect(readUpdateNotes(value)).toEqual(none);
    }
  });

  it("keeps the releases of an answer whose count or commit is not in shape", () => {
    expect(readUpdateNotes({ releases: notes.releases, omitted: -1, revision: 7 })).toEqual({ revision: null, releases: notes.releases, omitted: 0 });
    expect(readUpdateNotes({ releases: notes.releases, omitted: 1.5 }).omitted).toBe(0);
  });
});

describe("a release's summary", () => {
  const summary = { en: "In short.", ko: "짧게." };

  it("is told in the app's language, else in English", () => {
    expect(summaryFor({ summary }, "ko")).toBe("짧게.");
    expect(summaryFor({ summary }, "ja")).toBe("In short.");
  });

  it("is none for a release that wrote none: its changelog section is what there is", () => {
    expect(summaryFor({}, "ko")).toBeNull();
    expect(summaryFor({ summary: { ko: "짧게." } }, "ja")).toBeNull();
  });

  it("is written in the languages the app has", () => {
    expect([...SUMMARY_LANGUAGES].sort()).toEqual(LANGUAGE_SETTINGS.filter((language) => language !== "system").sort());
  });

  it("arrives with its release, and without what is not text in such a language", () => {
    const sent = { revision: "b".repeat(40), omitted: 0, releases: [
      { version: "0.4.0", date: null, notes: "text", summary: { en: "In short.", ko: 7, fr: "Bref.", ja: " " } },
      { version: "0.3.9", date: null, notes: "text", summary: "short" },
      { version: "0.3.8", date: null, notes: "text", summary: { fr: "Bref." } },
    ] };
    expect(readUpdateNotes(sent).releases).toEqual([
      { version: "0.4.0", date: null, notes: "text", summary: { en: "In short." } },
      { version: "0.3.9", date: null, notes: "text" },
      { version: "0.3.8", date: null, notes: "text" },
    ]);
  });
});

describe("what the last update brought", () => {
  const running = { current_revision: "b".repeat(40) };
  const installed: InstalledNotes = { revision: running.current_revision, version: "0.4.0", previous_version: "0.3.9", installed_at: "2026-10-07T00:00:00.000Z",
    releases: [{ version: "0.4.0", date: "2026-10-07", notes: "### Added\n- A thing.", summary: { en: "A thing." } }], omitted: 0 };
  const at = Date.parse(installed.installed_at!);

  it("is shown for the commit that runs", () => {
    expect(installedUpdate(running, installed)).toBe(installed);
  });

  it("is nothing before an answer, on a server no update installed, or for another commit", () => {
    expect(installedUpdate(null, installed)).toBeNull();
    expect(installedUpdate(running, null)).toBeNull();
    expect(installedUpdate({ current_revision: null }, installed)).toBeNull();
    expect(installedUpdate(running, readInstalledNotes({}))).toBeNull();
    expect(installedUpdate({ current_revision: "c".repeat(40) }, installed)).toBeNull();
  });

  it("is announced until this device closes it for that version", () => {
    expect(announcesUpdate(installed, null, at + 60_000)).toBe(true);
    expect(announcesUpdate(installed, "0.3.9", at + 60_000)).toBe(true);
    expect(announcesUpdate(installed, "0.4.0", at + 60_000)).toBe(false);
  });

  it("is announced for a week, and not at all when its time is not known", () => {
    expect(announcesUpdate(installed, null, at + ANNOUNCED_FOR_MS - 1)).toBe(true);
    expect(announcesUpdate(installed, null, at + ANNOUNCED_FOR_MS)).toBe(false);
    expect(announcesUpdate({ ...installed, installed_at: null }, null, at)).toBe(false);
    expect(announcesUpdate({ ...installed, installed_at: "yesterday" }, null, at)).toBe(false);
    expect(announcesUpdate(null, null, at)).toBe(false);
  });

  it("arrives in shape, or as no update", () => {
    expect(readInstalledNotes(JSON.parse(JSON.stringify(installed)))).toEqual(installed);
    const none = { revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 };
    for (const value of [undefined, null, 7, {}, { ...installed, releases: "all" }, { ...installed, revision: null },
      { ...installed, version: 4 }, { ...installed, previous_version: null }, { ...installed, releases: [{ version: "0.4.0" }] }]) {
      expect(readInstalledNotes(value)).toEqual(none);
    }
    expect(readInstalledNotes({ ...installed, installed_at: 7, omitted: -2 })).toEqual({ ...installed, installed_at: null, omitted: 0 });
  });
});
