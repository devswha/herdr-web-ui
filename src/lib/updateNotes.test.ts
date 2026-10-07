import { describe, expect, it } from "bun:test";
import { readUpdateNotes, type UpdateNotes } from "../../shared/update.ts";
import { ApiError } from "./api.ts";
import { notesOffer, notesRetryDelay, notesUnboundDelay, offeredNotes } from "./updateNotes.ts";

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
