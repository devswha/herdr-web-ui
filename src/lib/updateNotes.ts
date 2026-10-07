import type { UpdateNotes, UpdateStatus } from "../../shared/update.ts";
import { ApiError } from "./api.ts";

/**
 * The notes to show beside an offered update: those read from the very commit the status
 * offers, until it is installed. Null when there are none to show. A check reports nothing
 * available while it runs, so `available` is not asked: the notes must not leave every five
 * minutes under someone reading them. The commit is compared, not the version: a tag moved to
 * another commit has other notes, and a release with an empty section still brings the
 * sections of the releases skipped before it.
 */
export function offeredNotes(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision"> | null,
  notes: UpdateNotes | null,
): UpdateNotes | null {
  if (!status || !notes || notes.releases.length === 0) return null;
  if (!status.latest_revision || status.latest_revision === status.current_revision) return null;
  return notes.revision === status.latest_revision ? notes : null;
}

/**
 * What the notes of an offer were read from, as one key: null when nothing is offered. The notes
 * are asked for once per key. The server picks the sections between the running version and the
 * release's, out of the release's commit: when any of the three moves (a tag added on the same
 * commit, an older build restored under the same offer), the answer is another.
 */
export function notesOffer(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision" | "current_version" | "latest_version"> | null,
): string | null {
  if (!status?.latest_revision || status.latest_revision === status.current_revision) return null;
  return [status.latest_revision, status.latest_version, status.current_revision, status.current_version].join(" ");
}

const retryDelay = (attempt: number): number => Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
/** An answer for another commit, or for none, is asked for again this many times. */
const UNBOUND_RETRIES = 5;

/**
 * How long to wait before asking again after an answer that is not the offered commit's; null
 * when it is left at that. A bridge that just restarted has not heard from its supervisor yet,
 * and a check may be between two releases: both pass within seconds. A supervisor older than
 * the notes never names a commit, so the asking ends, after about a minute.
 */
export function notesUnboundDelay(attempt: number): number | null {
  return attempt < UNBOUND_RETRIES ? retryDelay(attempt) : null;
}

/**
 * How long to wait before asking for the notes again after a failed request; null when asking
 * again changes nothing. A dropped connection or a bridge that restarts passes. A server older
 * than the notes refuses the request itself (405), every time.
 */
export function notesRetryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
  return retryDelay(attempt);
}
