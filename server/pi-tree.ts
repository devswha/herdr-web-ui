/**
 * pi's session file is an append-only entry tree, not a linear log: entries link to
 * their predecessor by id/parentId, and /tree moves the leaf back to an earlier entry
 * without rewriting the file, so a later append grows a branch beside the abandoned
 * one. The conversation pi shows — and the chat must show — is the path from the last
 * entry written back to its root; entries on a side branch stay in the file, unread.
 * Parents always precede their children (verified against every session in a real
 * store), so the last line is the leaf and one forward pass indexes the tree.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

/** A branch longer than this reads the file whole instead; a session that large predates paging. */
export const MAX_BRANCH_BYTES = 64 * 1024 * 1024;

/** One range of the transcript file, in the order it should be read. */
export interface TranscriptSegment { start: number; end: number }

interface PiEntry { id: string; parent: string | null; start: number; end: number; type: string; role: string; summary: string | null }
interface PiIndex {
  /** the tree's children in append order; entries without an id (the session header) are not nodes */
  entries: PiEntry[];
  children: Map<string, PiEntry[]>;
  /** bytes scanned into entries; appends extend it, one line at a time, never a rewrite */
  scanned: number;
  /** the 64 bytes before `scanned`, which no append overwrites */
  tail: string;
}

/** The cache is per-file and revalidated by the scanned-tail check, like the clear scans. */
const piIndexes = new Map<string, PiIndex>();

function indexEntry(line: string, start: number, end: number): PiEntry | null {
  if (!line.includes('"id"')) return null; // the header and a torn fragment answer no sooner
  let entry: { id?: unknown; parentId?: unknown; type?: unknown; summary?: unknown; message?: { role?: unknown } };
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry.id !== "string" || entry.id.length === 0) return null;
  // type and role are taken here because the line is parsed for this anyway: what counts as a
  // turn is decided later by a reader that must not pay for a second pass over the file
  const message = entry.message;
  const role = message !== null && typeof message === "object" && typeof message.role === "string" ? message.role : "";
  return {
    id: entry.id,
    parent: typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : null,
    start,
    end,
    type: typeof entry.type === "string" ? entry.type : "",
    role,
    summary: typeof entry.summary === "string" ? entry.summary : null,
  };
}

function buildIndex(path: string, size: number): PiIndex {
  const index: PiIndex = { entries: [], children: new Map(), scanned: 0, tail: "" };
  extendIndex(index, path, size);
  return index;
}

const INDEX_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Appends whole lines from `scanned` on; a last line still without its newline waits for
 * it, so `scanned` always names a line boundary and the bytes before it never change.
 */
function extendIndex(index: PiIndex, path: string, size: number): void {
  if (index.scanned >= size) return;
  const fd = openSync(path, "r");
  try {
    let end = index.scanned; // absolute offset just past the bytes held in `bytes`
    let carry = Buffer.alloc(0);
    while (end < size) {
      const want = Math.min(INDEX_CHUNK_BYTES, size - end);
      const chunk = Buffer.alloc(want);
      const got = readSync(fd, chunk, 0, want, end);
      if (got <= 0) break;
      const bytes = Buffer.concat([carry, chunk.subarray(0, got)]);
      const base = end - carry.length; // absolute offset of bytes[0]
      let offset = 0;
      for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
        const entry = indexEntry(bytes.subarray(offset, newline).toString("utf8"), base + offset, base + newline + 1);
        if (entry) addEntry(index, entry);
        offset = newline + 1;
      }
      carry = bytes.subarray(offset);
      end += got;
    }
    index.scanned = end - carry.length;
  } finally { closeSync(fd); }
  index.tail = readBefore(path, index.scanned, 64);
}

function readBefore(path: string, offset: number, bytes: number): string {
  const from = Math.max(0, offset - bytes);
  if (from >= offset) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(offset - from);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from)).toString("latin1");
  } finally { closeSync(fd); }
}

function addEntry(index: PiIndex, entry: PiEntry): void {
  index.entries.push(entry);
  if (entry.parent === null) return;
  const siblings = index.children.get(entry.parent);
  if (siblings) siblings.push(entry);
  else index.children.set(entry.parent, [entry]);
}

/** The tree as it stands, or null when the file cannot be read at all. */
export function piEntryIndex(path: string): PiIndex | null {
  let size: number;
  try { size = statSync(path).size; } catch { return null; }
  const cached = piIndexes.get(path);
  // an append cannot disturb what was scanned — parents precede children — but a rewrite,
  // a truncation or an in-place replacement can, and only the tail check tells them apart
  if (cached && cached.scanned <= size && readBefore(path, cached.scanned, 64) === cached.tail) {
    extendIndex(cached, path, size);
    return cached;
  }
  const fresh = buildIndex(path, size);
  piIndexes.set(path, fresh);
  if (piIndexes.size > 32) piIndexes.delete(piIndexes.keys().next().value!);
  return fresh;
}

/**
 * The active branch: the last entry written back to its root, oldest first, as byte
 * ranges of the file. Adjacent entries merge into one range, so a session no /tree
 * touched reads as the single prefix it is. An id repeated (never pi, but never
 * trusted) keeps its last append; a branch over MAX_BRANCH_BYTES reads whole instead
 * of projected. Null when the tree cannot be read, or holds no entry at all.
 */
export function piBranchSegments(path: string, size: number): TranscriptSegment[] | null {
  const index = piEntryIndex(path);
  if (index === null || index.entries.length === 0) return null;
  // a file no longer the one indexed (shorter than the scan) says so through piEntryIndex
  if (index.entries[index.entries.length - 1]!.end > size) return null;
  const byId = new Map<string, PiEntry>();
  for (const entry of index.entries) byId.set(entry.id, entry); // later appends win
  const leaf = index.entries[index.entries.length - 1]!;
  const chain: PiEntry[] = [];
  const seen = new Set<string>();
  let next: PiEntry | undefined = leaf;
  let total = 0;
  while (next !== undefined && !seen.has(next.id)) {
    seen.add(next.id);
    chain.push(next);
    total += next.end - next.start;
    if (total > MAX_BRANCH_BYTES) return null;
    const parent: PiEntry | undefined = next.parent === null ? undefined : byId.get(next.parent);
    // a parent that never appears (a foreign id, a torn index) ends the walk short:
    // what it still resolves to is shown, the unreadable head is not invented
    next = parent;
  }
  const segments: TranscriptSegment[] = [];
  for (const entry of chain.reverse()) {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.end === entry.start) last.end = entry.end;
    else segments.push({ start: entry.start, end: entry.end });
  }
  return segments;
}

/**
 * What the file holds that the chat cannot show: the turns on paths pi walked away from.
 *
 * pi keeps the leaf pointer to itself. `branch()` moves it and writes no entry, and no entry type
 * names the leaf, so the only branch a reader of the file can rebuild is the one ending at the
 * last entry written. Every other message in the file was abandoned, and the chat hides it with no
 * trace it was ever there — which is what this counts, so the reader can say so out loud.
 *
 * `count` is turns, not entries: pi's own markers and a tool's result are not bubbles the chat
 * would have shown. A turn abandoned into several branches is counted once. `branches` is how many
 * places the navigation happened — the places a live entry was given a child that is not itself
 * live — which a turn count cannot tell the reader: "4 turns left behind" reads nothing alike for
 * one abandoned path of 4 and two abandoned paths of 2, and the label pluralizes on it, not on the
 * turns. `summary` carries pi's own account of the abandoned path when the user answered `/tree`'s
 * "Summarize branch?" with a summary — a `branch_summary` entry written on the new branch. `fromId`
 * names where the abandoned path ended but is not read: the count comes from the tree, which
 * already knows, and one more source of truth would be one to keep in step. Null when the tree
 * cannot be walked, and all zeroes for a session no `/tree` touched, which is the common case and
 * must cost the client nothing.
 */
export function piAbandonedTurns(path: string, size: number): { count: number; branches: number; summary: string | null } | null {
  const index = piEntryIndex(path);
  if (index === null || index.entries.length === 0) return null;
  if (index.entries[index.entries.length - 1]!.end > size) return null;
  const byId = new Map<string, PiEntry>();
  for (const entry of index.entries) byId.set(entry.id, entry); // later appends win
  const live = new Set<string>();
  let next: PiEntry | undefined = index.entries[index.entries.length - 1]!;
  while (next !== undefined && !live.has(next.id)) {
    live.add(next.id);
    next = next.parent === null ? undefined : byId.get(next.parent);
  }
  let count = 0;
  let branches = 0;
  let summary: string | null = null;
  // a branch is a place the pointer was moved away from: a live entry with a child left behind, so
  // an abandoned path attached to the path still in play. Attached is the word — pi's session header
  // is a root no entry ever links to, orphaned from the moment it is written, and counting heads of
  // abandoned paths instead would report it as a navigation in every session there has ever been
  for (const id of live) {
    // ids deduped the way piBranchSegments dedupes them: an entry appended twice (never pi, never
    // trusted) is still one place navigated away from
    const left = new Set<string>();
    for (const child of index.children.get(id) ?? []) if (!live.has(child.id)) left.add(child.id);
    branches += left.size;
  }
  for (const entry of index.entries) {
    // pi's summary of an abandoned path sits on the branch that replaced it, so only one on the
    // live path describes what the chat is hiding here; the newest wins, as a later /tree
    // supersedes an earlier answer
    if (entry.type === "branch_summary") {
      if (!live.has(entry.id)) continue;
      if (entry.summary !== null && entry.summary.trim().length > 0) summary = entry.summary;
      continue;
    }
    if (live.has(entry.id) || entry.type !== "message") continue;
    // a tool call and its result are one step of the turn that asked for them, counted with it
    if (entry.role !== "user" && entry.role !== "assistant") continue;
    count += 1;
  }
  return { count, branches, summary };
}
