/** App updates are independent of the herdr daemon and its terminal sessions. */
export interface UpdateStatus {
  managed: boolean;
  auto_update: boolean;
  phase: "idle" | "checking" | "building" | "restarting" | "error";
  /** Commit ids: what is running and what the latest release tag points at. */
  current_revision: string | null;
  latest_revision: string | null;
  /** Human versions: the running build's package.json and the latest `vX.Y.Z` tag, without the v. */
  current_version: string | null;
  latest_version: string | null;
  available: boolean;
  checked_at: string | null;
  blocked_reason: string | null;
  error: string | null;
  /**
   * What a running install is doing; null outside one. Absent from a supervisor older than this
   * field: an update is always run by the version being replaced.
   */
  step?: UpdateStep | null;
}

/** An install's steps, in the order it takes them. */
export const UPDATE_STEPS = ["download", "dependencies", "typecheck", "build", "restart"] as const;
export type UpdateStep = typeof UPDATE_STEPS[number];

export type UpdateCommand = "check" | "install";

/** The languages a release's summary is written in: the app's own (src/lib/i18n.ts). */
export const SUMMARY_LANGUAGES = ["en", "ko", "ja", "zh"] as const;
export type SummaryLanguage = typeof SUMMARY_LANGUAGES[number];
/** A release told in a few sentences, per language; a language the release did not write is absent. */
export type ReleaseSummary = Partial<Record<SummaryLanguage, string>>;

/** One release's section of CHANGELOG.md, and its summary from release-summaries.json. */
export interface ReleaseNote {
  /** without the v */
  version: string;
  /** the date in the section's heading, as written there; null when it has none */
  date: string | null;
  /** the section's body, Markdown */
  notes: string;
  /** plain text; absent from a release older than the summaries, and from one that wrote none */
  summary?: ReleaseSummary;
}

/**
 * GET /api/updates/notes: what the available update brings. Asked for once per release, and
 * kept out of the status, which is polled.
 */
export interface UpdateNotes {
  /** the commit of the release these notes were read from, the status's `latest_revision` then; null when no update is offered */
  revision: string | null;
  /** every release after the running one, up to the latest, newest first; empty when no update is offered or its changelog has no section for it */
  releases: ReleaseNote[];
  /** older releases the update also brings, left out for length */
  omitted: number;
}

export function noUpdateNotes(): UpdateNotes {
  return { revision: null, releases: [], omitted: 0 };
}

/**
 * GET /api/updates/installed: what the last update brought, read from the running release's own
 * files. Asked for once per running release, like the notes of an offer.
 */
export interface InstalledNotes {
  /** the commit that runs, the status's `current_revision`; null when no update was installed (a source checkout, an unmanaged server) */
  revision: string | null;
  /** the running version and the one the update replaced, without the v */
  version: string | null;
  previous_version: string | null;
  /** when the update was installed, ISO */
  installed_at: string | null;
  /** every release after the replaced one, up to the running one, newest first; empty when the release has no changelog section for them */
  releases: ReleaseNote[];
  /** older releases the update also brought, left out for length */
  omitted: number;
}

export function noInstalledNotes(): InstalledNotes {
  return { revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 };
}

/** A summary as it arrived: the languages that are text, and nothing when none is. */
function readSummary(value: unknown): ReleaseSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const summary: ReleaseSummary = {};
  for (const language of SUMMARY_LANGUAGES) {
    const text = (value as Record<string, unknown>)[language];
    if (typeof text === "string" && text.trim() !== "") summary[language] = text;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** The releases of an answer, or null when one of them is not in shape. */
function readReleases(value: unknown): ReleaseNote[] | null {
  if (!Array.isArray(value)) return null;
  const releases: ReleaseNote[] = [];
  for (const entry of value as Array<Partial<Record<keyof ReleaseNote, unknown>> | null>) {
    if (typeof entry?.version !== "string" || typeof entry.notes !== "string") return null;
    if (entry.date !== null && typeof entry.date !== "string") return null;
    const summary = readSummary(entry.summary);
    releases.push({ version: entry.version, date: entry.date, notes: entry.notes, ...(summary ? { summary } : {}) });
  }
  return releases;
}

const readOmitted = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

/**
 * Notes as another process or another version sent them (the supervisor over IPC, the server
 * over HTTP). Anything that is not in shape is no notes: they are drawn as they are.
 */
export function readUpdateNotes(value: unknown): UpdateNotes {
  const notes = value as Partial<Record<keyof UpdateNotes, unknown>> | null | undefined;
  const releases = typeof notes === "object" && notes !== null ? readReleases(notes.releases) : null;
  if (!notes || !releases) return noUpdateNotes();
  return { revision: typeof notes.revision === "string" ? notes.revision : null, releases, omitted: readOmitted(notes.omitted) };
}

/** The last update's notes, read as `readUpdateNotes` reads an offer's. An update is told only with both of its versions. */
export function readInstalledNotes(value: unknown): InstalledNotes {
  const notes = value as Partial<Record<keyof InstalledNotes, unknown>> | null | undefined;
  const releases = typeof notes === "object" && notes !== null ? readReleases(notes.releases) : null;
  if (!notes || !releases) return noInstalledNotes();
  if (typeof notes.revision !== "string" || typeof notes.version !== "string" || typeof notes.previous_version !== "string") return noInstalledNotes();
  return {
    revision: notes.revision, version: notes.version, previous_version: notes.previous_version,
    installed_at: typeof notes.installed_at === "string" ? notes.installed_at : null,
    releases, omitted: readOmitted(notes.omitted),
  };
}

export function unmanagedUpdateStatus(): UpdateStatus {
  return {
    managed: false, auto_update: false, phase: "idle", current_revision: null,
    latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: null, error: null,
    blocked_reason: "Start with bun run start or the herdr plugin to enable updates.",
  };
}

/**
 * herdr itself, updated from the app (server/herdr-update.ts): the server runs
 * `herdr update --handoff` for the herdr it talks to, on its own PC.
 */
export interface HerdrUpdateStatus {
  /** false where the server offers no herdr update (Windows, a herdr that does not answer): the controls stay hidden */
  supported: boolean;
  phase: "idle" | "updating" | "error";
  /** the running herdr server, and the herdr binary installed beside it */
  server_version: string | null;
  binary_version: string | null;
  /** the installed binary is newer than the running server: an update moves the panes onto it */
  stale: boolean;
  /** what herdr printed on the last run, its tail; null before any run and while one runs */
  output: string | null;
  finished_at: string | null;
}
