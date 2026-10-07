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

/** One release's section of CHANGELOG.md. */
export interface ReleaseNote {
  /** without the v */
  version: string;
  /** the date in the section's heading, as written there; null when it has none */
  date: string | null;
  /** the section's body, Markdown */
  notes: string;
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
 * Notes as another process or another version sent them (the supervisor over IPC, the server
 * over HTTP). Anything that is not in shape is no notes: they are drawn as they are.
 */
export function readUpdateNotes(value: unknown): UpdateNotes {
  const notes = value as Partial<Record<keyof UpdateNotes, unknown>> | null | undefined;
  if (typeof notes !== "object" || notes === null || !Array.isArray(notes.releases)) return noUpdateNotes();
  const releases: ReleaseNote[] = [];
  for (const entry of notes.releases as Array<Partial<Record<keyof ReleaseNote, unknown>> | null>) {
    if (typeof entry?.version !== "string" || typeof entry.notes !== "string") return noUpdateNotes();
    if (entry.date !== null && typeof entry.date !== "string") return noUpdateNotes();
    releases.push({ version: entry.version, date: entry.date, notes: entry.notes });
  }
  return {
    revision: typeof notes.revision === "string" ? notes.revision : null,
    releases,
    omitted: typeof notes.omitted === "number" && Number.isSafeInteger(notes.omitted) && notes.omitted > 0 ? notes.omitted : 0,
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
