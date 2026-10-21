/**
 * Durable replacement of private security records: the paired-device registry (and its closed
 * gate), the VAPID key pair and the push subscriptions. Losing one of these acknowledged writes
 * on a crash or power loss brings back a revoked device or orphans every phone's push
 * subscription, and none of them can be recomputed, so the new bytes are flushed before they
 * replace the old file.
 *
 * A unique temporary file is created exclusively in the same directory at 0600 (the directory
 * is created 0700), all bytes are written, the file is fsynced and closed, then renamed over the
 * destination. The destination always ends up 0600: its old mode is never copied. A failure up
 * to and including the rename throws and leaves the destination as it was. Afterwards the parent
 * directory is fsynced on POSIX so the rename itself is recorded; that step is best effort (some
 * filesystems refuse it), so its failure is returned, not thrown: the new document is already in
 * place and readable, only the guarantee that the rename survives power loss is weaker.
 *
 * High-frequency writes (last-seen telemetry, retired push endpoints, preferences) do not come
 * here: they are cheap to lose and would pay an fsync each time.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** The filesystem calls the writer makes, in one place so tests can replace them with scoped spies. */
export const privateStateFs = { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync };

export interface PrivateStateWrite {
  /** false when the parent-directory fsync after the rename failed or was not attempted (Windows) */
  directorySynced: boolean;
}

export function writePrivateState(path: string, value: unknown, platform: NodeJS.Platform = process.platform): PrivateStateWrite {
  const fs = privateStateFs;
  const directory = dirname(path);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  // "wx": O_CREAT | O_EXCL, so this call never writes into a file it did not create
  let fd: number | null = fs.openSync(temporary, "wx", 0o600);
  try {
    for (let written = 0; written < bytes.length;) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written);
      if (count <= 0) throw new Error(`wrote no bytes to ${temporary}`);
      written += count;
    }
    fs.fsyncSync(fd);
    const closing = fd;
    fd = null; // a failed close must not be retried: the descriptor is released either way
    fs.closeSync(closing);
    fs.renameSync(temporary, path);
  } catch (error) {
    // Cleanup failures must not mask the write failure the caller has to see.
    if (fd !== null) try { fs.closeSync(fd); } catch { /* reported through `error` */ }
    try { fs.unlinkSync(temporary); } catch { /* reported through `error` */ }
    throw error;
  }
  if (platform === "win32") return { directorySynced: false };
  let directoryFd: number | null = null;
  try {
    directoryFd = fs.openSync(directory, "r");
    fs.fsyncSync(directoryFd);
    return { directorySynced: true };
  } catch {
    return { directorySynced: false };
  } finally {
    if (directoryFd !== null) try { fs.closeSync(directoryFd); } catch { /* the rename already succeeded */ }
  }
}
