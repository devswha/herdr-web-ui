import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { OmoTodo } from "../shared/protocol.ts";
import { noTurn, omoTurnAfter, type OmoLine, type OmoTurn } from "./omo-status.ts";

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Invalid records do not replace the latest valid state; an explicit clear does. */
export function parseTodos(data: unknown): OmoTodo[] | null {
  if (!object(data) || data.schema !== "v2" || !Array.isArray(data.phases)) return null;
  const todos: OmoTodo[] = [];
  for (const phase of data.phases) {
    if (!object(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    for (const task of phase.tasks) {
      if (!object(task) || typeof task.content !== "string") return null;
      const status = task.status;
      if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "abandoned") return null;
      todos.push({ phase: phase.name, content: task.content, status });
    }
  }
  return todos;
}

export interface ProgressRecord {
  readonly todos: OmoTodo[] | null;
  readonly turn: OmoTurn;
}
const empty = (): ProgressRecord => ({ todos: null, turn: noTurn() });
const CHUNK = 256 * 1024;
const LINE_LIMIT = 64 * 1024;
const END = 4096;
export const PROGRESS_READ_BUDGET = 8 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

/** Mutable scan state: bytes, never transcript bodies, survive between bounded reads. */
interface Scan {
  file: string; offset: number; size: number; mtime: number; tail: Buffer;
  parts: Buffer[]; held: number; head: Buffer | null; lineTail: Buffer;
  nodes: Map<string, ProgressRecord>; leaf: ProgressRecord; overflow: boolean;
}

function before(fd: number, offset: number): Buffer {
  const bytes = Buffer.alloc(Math.min(64, offset));
  return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset - bytes.length));
}

function apply(scan: Scan, line: OmoLine): void {
  const head = "text" in line ? line.text : line.head;
  let entry: Record<string, unknown>;
  if ("text" in line) {
    try {
      const parsed: unknown = JSON.parse(line.text);
      if (!object(parsed)) return;
      entry = parsed;
    } catch { return; } // a malformed/torn JSON record is not state
  } else {
    // Oversized transcript messages keep only their structural prefix and stop reason.
    entry = {
      id: head.match(/^\{"type":"[^"]+","id":"([^"]+)"/)?.[1],
      parentId: head.match(/"parentId":"([^"]+)"/)?.[1] ?? null,
    };
  }
  if (typeof entry.id !== "string" || entry.type === "session") return;
  const parent = typeof entry.parentId === "string" ? scan.nodes.get(entry.parentId) : undefined;
  const prior = parent ?? empty();
  const todos = entry.type === "custom" && entry.customType === "senpi.todo-state" ? parseTodos(entry.data) : null;
  const next: ProgressRecord = {
    todos: todos ?? prior.todos,
    turn: omoTurnAfter(prior.turn, line),
  };
  scan.nodes.set(entry.id, next);
  scan.leaf = next;
  if (scan.nodes.size > MAX_ENTRIES) { scan.overflow = true; scan.nodes.clear(); }
}

/** Latest valid todo on the last-written branch, independent of conversation pagination.
 * Like pi-tree, an unwritten /tree leaf move cannot be recovered from JSONL alone.
 * Each call reads at most 8 MiB; while catching up, it returns unknown rather than old state.
 */
export class OmoProgressRecords {
  private readonly scans = new Map<string, Scan>();

  read(path: string): ProgressRecord {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return empty();
      const file = `${stat.dev}:${stat.ino}`;
      let scan = this.scans.get(path);
      if (!scan || scan.file !== file || stat.size < scan.offset || stat.size < scan.size ||
          (stat.size === scan.size && stat.mtimeMs !== scan.mtime) ||
          !before(fd, scan.offset).equals(scan.tail)) {
        scan = { file, offset: 0, size: 0, mtime: 0, tail: Buffer.alloc(0), parts: [], held: 0,
          head: null, lineTail: Buffer.alloc(0), nodes: new Map(), leaf: empty(), overflow: false };
        this.scans.set(path, scan);
        if (this.scans.size > 32) {
          const oldest = this.scans.keys().next().value;
          if (oldest !== undefined) this.scans.delete(oldest);
        }
      }
      const end = Math.min(stat.size, scan.offset + PROGRESS_READ_BUDGET);
      while (scan.offset < end && !scan.overflow) {
        const chunk = Buffer.alloc(Math.min(CHUNK, end - scan.offset));
        const got = readSync(fd, chunk, 0, chunk.length, scan.offset);
        if (got === 0) break;
        const bytes = chunk.subarray(0, got);
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start);
          const piece = bytes.subarray(start, newline === -1 ? bytes.length : newline);
          if (scan.head !== null) scan.lineTail = Buffer.concat([scan.lineTail, piece]).subarray(-END);
          else {
            scan.parts.push(piece); scan.held += piece.length;
            if (scan.held > LINE_LIMIT) {
              const held = Buffer.concat(scan.parts);
              scan.head = held.subarray(0, END);
              scan.lineTail = held.subarray(-END);
              scan.parts = [];
            }
          }
          if (newline === -1) break;
          apply(scan, scan.head === null ? { text: Buffer.concat(scan.parts).toString("utf8") } :
            { head: scan.head.toString("utf8"), tail: scan.lineTail.toString("utf8") });
          scan.parts = []; scan.held = 0; scan.head = null; scan.lineTail = Buffer.alloc(0);
          start = newline + 1;
          if (scan.overflow) break;
        }
        scan.offset += got;
      }
      scan.tail = before(fd, scan.offset);
      scan.size = stat.size; scan.mtime = stat.mtimeMs;
      return scan.offset < stat.size || scan.overflow ? empty() : scan.leaf;
    } catch { return empty(); } // unreadable session is unknown, never a cached active task
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
