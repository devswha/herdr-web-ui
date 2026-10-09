/**
 * Hermes Agent's own session store, read-only (Hermes 2026.9.24, `state.db` schema 31).
 *
 * Hermes keeps every conversation in one SQLite database, `<Hermes home>/state.db`. The home is
 * `HERMES_HOME`, else `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows), and a profile
 * (`hermes -p <name>`) is `<home>/profiles/<name>` (hermes_constants.py). A session is a `sessions`
 * row and its conversation the `messages` rows of its id in `id` order, in OpenAI's shape: `user`,
 * `assistant` with `tool_calls`, and `tool` answering one call by `tool_call_id`.
 *
 * A pane is bound to a session only by what proves it, never by its directory or recency:
 * - herdr's Hermes integration reports the session the pane's Hermes shows (`herdr:hermes`, kind
 *   `id`), again after a `/new`;
 * - without it, Hermes's own lease registry (`runtime/active_sessions.json`) names the session each
 *   live process holds, and one of the pane's foreground processes holds it (the classic CLI is
 *   that process, the TUI's gateway is a child in the same group). The classic CLI keeps its lease
 *   on the session a `/new` ended, so a leased session that has ended is no answer.
 *
 * The chat shows what Hermes's own display projection shows (`hermes_state_messages.py`): rows that
 * are live or that a compaction summarized away (`active = 1 OR compacted = 1`), never one marked
 * model-only, and one row per `display_order` group, the live copy first, then the newest (a
 * compaction copies its protected tail into each generation). A page is a range of groups, so a
 * cursor names a group: one an undo or rewind removed is refused, and `rewind_count` is part of
 * the history id.
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { pageStart, type RowMeta } from "./opencode.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

/** Hermes may hold the write lock for a moment; a read waits this long, never more. */
const BUSY_TIMEOUT_MS = 250;
/** The newest page is read on every poll while the agent works: at most this much of the session. */
const WINDOW_BYTES = 16 * 1024 * 1024;
/** One message's text on a page; a longer one is cut with a visible mark. */
const MAX_TEXT = 256 * 1024;
const LEASES_MAX_BYTES = 1024 * 1024;
const MAX_PROFILES = 64;
/** `_encode_content` writes list content (multimodal parts) as JSON behind this marker. */
const CONTENT_JSON_PREFIX = "\u0000json:";
/** Hermes's ids are `<date>_<time>_<hex>`; a gateway's may be other words, never a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A tool call's whole output: the `tool` row answering it. */
export const HERMES_TOOL_REF = /^hermes:(\d{1,15})$/;

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const nonblank = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
const cut = (value: string): string => value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n… trimmed` : value;
const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
};
/** Hermes stamps rows in seconds since the epoch. */
const stamp = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 1e11 ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** The homes Hermes itself would use: HERMES_HOME, else the platform's default. */
export function hermesHomeRoots(env: Record<string, string | undefined> = process.env, home = homedir(), platform: string = process.platform): string[] {
  const suffix = env["HERMES_DATA_DIR_SUFFIX"] ?? "";
  const native = platform === "win32"
    ? join(env["LOCALAPPDATA"]?.trim() || join(home, "AppData", "Local"), `hermes${suffix}`)
    : join(home, `.hermes${suffix}`);
  const named = env["HERMES_HOME"]?.trim();
  const expanded = named === undefined || named === "" ? null
    : resolve(named === "~" ? home : named.startsWith("~/") ? join(home, named.slice(2)) : named);
  return [...new Set([...(expanded === null ? [] : [expanded]), native])];
}

/** Each root and every profile under it (`<root>/profiles/<name>`): a pane's Hermes may run any of them. */
export function hermesHomes(roots: readonly string[]): string[] {
  const homes: string[] = [];
  for (const root of roots) {
    homes.push(root);
    let names: string[] = [];
    try { names = readdirSync(join(root, "profiles")).filter((name) => !name.startsWith(".")).sort(); } catch { /* no profiles */ }
    for (const name of names.slice(0, MAX_PROFILES)) homes.push(join(root, "profiles", name));
  }
  return [...new Set(homes)];
}

/** The session herdr's Hermes integration reported for the pane, or null for any other report. */
export function hermesReportedSession(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "hermes" || session.source !== "herdr:hermes" || session.kind !== "id" || !SESSION_ID.test(session.value)) return null;
  return session.value;
}

interface Lease { home: string; session: string; pid: number }

/** The sessions live Hermes processes of one home hold, by pid (hermes_cli/active_sessions.py). */
function leases(home: string): Lease[] {
  const path = join(home, "runtime", "active_sessions.json");
  try {
    if (statSync(path).size > LEASES_MAX_BYTES) return [];
    const entries = record(JSON.parse(readFileSync(path, "utf8"))).entries;
    return (Array.isArray(entries) ? entries : []).map(record).flatMap((entry) => {
      const pid = typeof entry.pid === "number" ? entry.pid : typeof entry.pid === "string" && /^\d{1,10}$/.test(entry.pid) ? Number(entry.pid) : NaN;
      const session = typeof entry.session_id === "string" && SESSION_ID.test(entry.session_id) ? entry.session_id : null;
      return session !== null && Number.isSafeInteger(pid) && pid > 0 ? [{ home, session, pid }] : [];
    });
  } catch { return []; }
}

/** The store, read-only; null when it cannot be opened (no file, not SQLite, not readable). */
function openStore(path: string): Database | null {
  try {
    const db = new Database(path, { readonly: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch { return null; }
}

function withStore<T>(path: string, read: (db: Database) => T): T | null {
  const db = openStore(path);
  if (db === null) return null;
  try { return read(db); }
  finally { db.close(); }
}

/** A store this reader cannot use (no `messages` yet, not a database at all), as opposed to one busy for a moment. */
function unusable(error: unknown): boolean {
  return error instanceof Error && (/no such (table|column)/.test(error.message) || (error as { code?: unknown }).code === "SQLITE_NOTADB");
}

function busy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

/**
 * Whether a store holds the session, and whether it has ended. `absent`: there is no store to
 * open (nothing written yet); `busy`: Hermes holds it for a moment; null: it is not a store this
 * reads.
 */
function sessionState(path: string, session: string): "missing" | "open" | "ended" | "absent" | "busy" | null {
  try {
    return withStore(path, (db) => {
      const row = db.query<{ ended_at: unknown }, [string]>("SELECT ended_at FROM sessions WHERE id = ?").get(session);
      return row === null ? "missing" : row.ended_at === null ? "open" : "ended";
    }) ?? "absent";
  } catch (error) { return busy(error) ? "busy" : null; }
}

export type HermesBinding =
  | { kind: "session"; path: string; session: string }
  /** the pane's Hermes holds a session it has not written yet: a chat with no turns */
  | { kind: "unwritten"; session: string }
  | { kind: "unavailable"; reason: "no_session_id" | "no_session_path" };

/**
 * The session a Hermes pane shows, from herdr's report or the lease one of `pids` (the pane's
 * foreground processes) holds. A report counts only for a pane herdr itself calls `hermes`: one
 * an earlier Hermes left behind says nothing about what runs now, and a lease is the process's own.
 */
export function hermesSessionForPane(pane: Pick<HerdrPane, "agent" | "agent_session">, pids: readonly number[], homes: readonly string[]): HermesBinding {
  const store = (home: string) => join(home, "state.db");
  const held = homes.flatMap(leases).filter((lease) => pids.includes(lease.pid));
  const heldHomes = [...new Set(held.map((lease) => lease.home))];
  const reported = pane.agent === "hermes" || held.length > 0 ? hermesReportedSession(pane) : null;
  if (reported !== null) {
    const states = new Map(homes.map((home) => [home, sessionState(store(home), reported)]));
    const where = (...wanted: (string | null)[]) => homes.filter((home) => wanted.includes(states.get(home)!));
    // the same id in two profiles is a copy: the one the pane's process holds is its own
    const own = (found: string[]) => found.length > 1 ? found.filter((home) => heldHomes.includes(home)) : found;
    const found = own(where("open", "ended"));
    if (found.length === 1) return { kind: "session", path: store(found[0]!), session: reported };
    if (found.length > 1) return { kind: "unavailable", reason: "no_session_path" };
    // a store Hermes holds for a moment may have it: the reader answers the page it kept
    const busy = own(where("busy"));
    if (busy.length === 1) return { kind: "session", path: store(busy[0]!), session: reported };
    // not written yet only where the pane's process runs and its store was read without it: a
    // home this server does not know of (HERMES_HOME set in the pane's shell alone) is no answer
    const [home] = heldHomes;
    if (heldHomes.length === 1 && (states.get(home!) === "missing" || states.get(home!) === "absent")) return { kind: "unwritten", session: reported };
    return { kind: "unavailable", reason: "no_session_path" };
  }
  const sessions = [...new Map(held.map((lease) => [`${lease.home}\0${lease.session}`, lease])).values()];
  if (sessions.length !== 1) return { kind: "unavailable", reason: "no_session_id" };
  const { home, session } = sessions[0]!;
  const state = sessionState(store(home), session);
  if (state === "open" || state === "busy") return { kind: "session", path: store(home), session };
  // a `/new` ends the session and keeps the lease: what the pane shows now is not this one
  if (state === "ended") return { kind: "unavailable", reason: "no_session_id" };
  if (state === "missing" || state === "absent") return { kind: "unwritten", session };
  return { kind: "unavailable", reason: "no_session_path" };
}

/** A row's `content` as Hermes wrote it: text, or structured parts behind `\0json:`. */
export function hermesContent(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith(CONTENT_JSON_PREFIX)) return value;
  try { return JSON.parse(value.slice(CONTENT_JSON_PREFIX.length)); } catch { return value; }
}

/** The text of a row's content: the string, or the text parts of a multimodal list. */
function contentText(value: unknown): string {
  const content = hermesContent(value);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(record).map((part) => typeof part.text === "string" ? part.text : "").filter((text) => text.length > 0).join("\n");
}

/** A `tool` row's output: a terminal call's `{output, exit_code, error}` unwrapped, anything else as written. */
export function hermesToolResult(value: unknown): { text: string; error: boolean } {
  const raw = contentText(value);
  const parsed = parseJson(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { text: raw, error: false };
  const result = parsed as Row;
  const failure = nonblank(result.error);
  const error = (typeof result.exit_code === "number" && result.exit_code !== 0) || failure !== null || result.success === false;
  if (typeof result.output === "string") {
    return { text: failure !== null && !result.output.includes(failure) ? [result.output, failure].filter(Boolean).join("\n") : result.output, error };
  }
  if (typeof result.content === "string") return { text: result.content, error };
  return { text: raw, error };
}

/** One `messages` row, the columns a turn is made of (a store without one reads it as null). */
export interface HermesRow {
  id: number;
  role: string;
  content: unknown;
  timestamp: unknown;
  tool_call_id: unknown;
  tool_calls: unknown;
  reasoning: unknown;
  reasoning_content: unknown;
  display_kind: unknown;
  summary: unknown;
}

/** An assistant row's calls: OpenAI's `{id, function: {name, arguments}}`, Hermes adding `call_id`. */
function toolCalls(value: unknown): { ids: string[]; name: string; args: string }[] {
  const parsed = parseJson(value);
  return (Array.isArray(parsed) ? parsed : []).map(record).flatMap((call) => {
    const fn = record(call.function);
    const name = nonblank(fn.name) ?? nonblank(call.name);
    if (name === null) return [];
    const ids = [call.id, call.call_id].filter((id): id is string => typeof id === "string" && id.length > 0);
    const args = typeof fn.arguments === "string" ? fn.arguments : fn.arguments === undefined ? "" : JSON.stringify(fn.arguments);
    return [{ ids: [...new Set(ids)], name, args }];
  });
}

/**
 * Display rows, in order -> turns. An assistant's rows and the tool results they wait for are one
 * turn until the next user row. A row Hermes shows as something other than a prompt (a model
 * switch, a skill it loaded, a delegated task coming back) sits in the user's seat as a notice;
 * a mid-turn steer is the user's own words.
 */
export function hermesTurns(rows: readonly HermesRow[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  const assistantTurn = (ts: string | null): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last?.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts, parts: [] };
    turns.push(turn);
    return turn;
  };
  for (const row of rows) {
    const ts = stamp(row.timestamp);
    const kind = nonblank(row.display_kind);
    if (kind === "hidden") continue;
    if (row.summary === 1 || row.summary === true) {
      const text = contentText(row.content).trim();
      if (text.length > 0) turns.push({ role: "user", ts, parts: [{ kind: "compact", text: cut(text) }] });
      continue;
    }
    if (row.role === "user") {
      const text = contentText(row.content);
      if (text.trim().length === 0) continue;
      const part: ConversationPart = kind === null || kind === "steer" ? { kind: "text", text: cut(text) } : { kind: "notice", text: cut(text), source: kind };
      turns.push({ role: "user", ts, parts: [part] });
      continue;
    }
    if (row.role === "assistant") {
      const parts: ConversationPart[] = [];
      const thinking = nonblank(row.reasoning) ?? nonblank(row.reasoning_content);
      if (thinking !== null) parts.push({ kind: "thinking", text: cut(thinking) });
      const text = contentText(row.content);
      if (text.trim().length > 0) parts.push({ kind: "text", text: cut(text) });
      for (const call of toolCalls(row.tool_calls)) {
        // one id is one call: listed again, it would take that call's output twice
        if (call.ids.some((id) => pending.has(id))) continue;
        const input = record(parseJson(call.args));
        const summary = toolSummary(call.name, input);
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool",
          name: call.name,
          // a web search names its query, which the shared summary does not look for
          summary: summary === call.name && typeof input.query === "string" ? input.query.slice(0, 120) : summary,
          input: Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : call.args,
          output: "",
        };
        parts.push(part);
        for (const id of call.ids) pending.set(id, part);
      }
      if (parts.length === 0) continue;
      const turn = assistantTurn(ts);
      turn.parts.push(...parts);
      if (ts !== null) turn.end_ts = ts;
      continue;
    }
    if (row.role === "tool" && typeof row.tool_call_id === "string") {
      const part = pending.get(row.tool_call_id);
      if (part === undefined || part.output.length > 0) continue;
      const result = hermesToolResult(row.content);
      trimOutput(part, result.text, `hermes:${row.id}`);
      if (result.error) part.error = true;
      const last = turns[turns.length - 1];
      if (last?.role === "assistant" && ts !== null) last.end_ts = ts;
    }
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

/** The page asked for: as conversation.ts's ConversationPage. */
export type HermesPage = { before?: string; since?: string; from?: string };

export type HermesAnswer =
  | { kind: "unavailable"; reason: string }
  | { kind: "history_changed" }
  | { kind: "page"; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; history_id: string; signature: string };

/** Per page asked for: the answer, while the session's signature holds. */
const answers = new Map<string, { signature: string; answer: Extract<HermesAnswer, { kind: "page" }> }>();

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Forget every answer kept between polls (tests compare against a cold read). */
export function forgetHermesState(): void {
  answers.clear();
}

/** What the answers are keyed by: a pane's chat is remembered against it (conversation.ts `rememberPaneRead`). */
export const hermesReadKey = (path: string, session: string): string => `hermes\0${path}\0${session}`;

/** Drop what one session's chat kept, when the last pane reading it closes; any other key is not one of these. */
export function forgetHermesRead(key: string): void {
  for (const entry of [...answers.keys()]) if (entry.startsWith(`${key}\0`)) answers.delete(entry);
}

function columns(db: Database, table: "messages" | "sessions"): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** One logical message: its `display_order` group and the row that stands for it. */
interface Group { display: number; id: number; active: number; prompt: boolean; size: number }

/**
 * One page of the session's conversation (as conversation.ts's transcriptPage, over groups):
 * without `before` the newest page, from `from` while that start is still inside it; with
 * `before` the page ending there, never reaching back past `since`. Columns newer than the
 * first schema this reads are optional: an older store reads them as absent.
 */
export function hermesConversation(path: string, session: string, page: HermesPage = {}): HermesAnswer {
  if (!SESSION_ID.test(session)) return { kind: "unavailable", reason: "no_session_id" };
  const cacheKey = `${hermesReadKey(path, session)}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}`;
  try {
    const answer = withStore(path, (db): HermesAnswer => {
      // every query below reads one snapshot of the store
      db.exec("BEGIN");
      const has = columns(db, "messages");
      if (!["id", "session_id", "role", "content", "timestamp"].every((name) => has.has(name))) return { kind: "unavailable", reason: "transcript_missing" };
      const sessionColumns = columns(db, "sessions");
      const optional = (name: string, table = has) => table.has(name) ? name : `NULL AS ${name}`;
      const sessionRow = db.query<{ model: unknown; model_config: unknown; rewind_count: unknown }, [string]>(
        `SELECT ${optional("model", sessionColumns)}, ${optional("model_config", sessionColumns)}, ${optional("rewind_count", sessionColumns)} FROM sessions WHERE id = ?`,
      ).get(session);
      if (sessionRow === null) return { kind: "unavailable", reason: "session_not_found" };
      const visible = has.has("active") ? has.has("compacted") ? " AND (active = 1 OR compacted = 1)" : " AND active = 1" : "";
      const rewinds = typeof sessionRow.rewind_count === "number" && sessionRow.rewind_count > 0 ? sessionRow.rewind_count : 0;
      const historyId = `hermes-${session}${rewinds > 0 ? `-r${rewinds}` : ""}`;
      const model = nonblank(sessionRow.model);
      const effort = nonblank(record(record(parseJson(sessionRow.model_config)).reasoning_config).effort);
      const stats = db.query<{ count: number; last: number | null; live: number | null; kinds: number | null }, [string]>(
        `SELECT count(*) AS count, max(id) AS last, ${has.has("active") ? "total(active)" : "NULL"} AS live, ${has.has("display_kind") ? "total(length(display_kind))" : "NULL"} AS kinds FROM messages WHERE session_id = ?${visible}`,
      ).get(session)!;
      const signature = `${historyId}:${stats.count}:${stats.last}:${stats.live}:${stats.kinds}:${model}:${effort}`;
      const cached = answers.get(cacheKey);
      if (cached?.signature === signature) return cached.answer;

      // Hermes's display projection, read without the rows' payloads: model-only rows out, one row per group
      const size = `length(CAST(coalesce(content, '') AS BLOB))${has.has("tool_calls") ? " + length(CAST(coalesce(tool_calls, '') AS BLOB))" : ""}`;
      const groups = new Map<number, Group>();
      for (const row of db.query<{ id: number; display: number; role: string; kind: unknown; summary: unknown; active: number; meta: unknown; size: number }, [string]>(
        `SELECT id, ${has.has("display_order") ? "coalesce(display_order, id)" : "id"} AS display, role,
          ${has.has("display_kind") ? "display_kind" : "NULL"} AS kind, ${has.has("_compressed_summary") ? "_compressed_summary" : "0"} AS summary,
          ${has.has("active") ? "active" : "1"} AS active,
          ${has.has("display_metadata") ? "CASE WHEN display_metadata LIKE '%model_only%' THEN display_metadata END" : "NULL"} AS meta,
          ${size} AS size
        FROM messages WHERE session_id = ?${visible} ORDER BY id`,
      ).iterate(session)) {
        if (row.meta !== null && record(parseJson(row.meta)).model_only) continue;
        const current = groups.get(row.display);
        const prompt = row.role === "user" && (row.kind === null || row.kind === "steer") && !row.summary;
        if (current === undefined || row.active > current.active || (row.active === current.active && row.id > current.id)) {
          groups.set(row.display, { display: row.display, id: row.id, active: row.active, prompt, size: row.size });
        }
      }
      const logical = [...groups.values()].sort((left, right) => left.display - right.display);
      const known = new Set(logical.map((group) => group.display));
      const cursorOf = (cursor: string): number | null => {
        const separator = cursor.lastIndexOf(":");
        const display = Number(cursor.slice(separator + 1));
        return separator > 0 && cursor.slice(0, separator) === historyId && known.has(display) ? display : null;
      };
      const descending = function* (from: number, to: number): Generator<RowMeta> {
        for (let index = logical.length - 1; index >= 0; index--) {
          const group = logical[index]!;
          if (group.display >= to) continue;
          if (group.display < from) return;
          yield { id: String(group.id), seq: group.display, type: group.prompt ? "user" : "other", updated: 0, size: group.size };
        }
      };
      let start: number;
      let to = Number.POSITIVE_INFINITY;
      if (page.before !== undefined) {
        const before = cursorOf(page.before);
        const floor = page.since === undefined ? 0 : cursorOf(page.since);
        if (before === null || floor === null || floor > before) return { kind: "history_changed" };
        start = before === floor ? floor : pageStart(descending(floor, before), floor, true, WINDOW_BYTES);
        to = before;
      } else {
        const held = page.from === undefined ? null : cursorOf(page.from);
        if (page.from !== undefined && held === null) return { kind: "history_changed" };
        const newest = pageStart(descending(0, to), 0, false, WINDOW_BYTES);
        // a chat that shows older pages keeps every turn after its held start while they are
        // inside the newest page; once the page moved past it, it fetches the turns between
        start = held !== null && held >= newest ? held : newest;
      }
      const shown = logical.filter((group) => group.display >= start && group.display < to);

      const rows = new Map<number, HermesRow>();
      const select = [
        "id", "role", "content", "timestamp", optional("tool_call_id"), optional("tool_calls"), optional("reasoning"), optional("reasoning_content"),
        optional("display_kind"), has.has("_compressed_summary") ? "_compressed_summary AS summary" : "0 AS summary",
      ].join(", ");
      for (let index = 0; index < shown.length; index += 500) {
        const ids = shown.slice(index, index + 500).map((group) => group.id);
        for (const row of db.query<HermesRow, (string | number)[]>(`SELECT ${select} FROM messages WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(session, ...ids)) {
          rows.set(row.id, row);
        }
      }
      const result = {
        kind: "page" as const,
        turns: hermesTurns(shown.flatMap((group) => rows.get(group.id) ?? [])),
        metadata: { model, reasoning_effort: effort },
        cursor: logical.some((group) => group.display < start) ? `${historyId}:${start}` : null,
        history_id: historyId,
        signature,
      };
      remember(answers, cacheKey, { signature, answer: result }, 32);
      return result;
    });
    return answer ?? { kind: "unavailable", reason: "transcript_missing" };
  } catch (error) {
    // a store Hermes has not finished creating, or not a store: the terminal stands in for it
    if (unusable(error)) return { kind: "unavailable", reason: "transcript_missing" };
    // a store held for a moment: the chat keeps the page it shows, or the terminal stands in
    // until the next poll, rather than an error in the chat
    if (busy(error)) return answers.get(cacheKey)?.answer ?? { kind: "unavailable", reason: "store_busy" };
    throw error;
  }
}

/** The whole output of a tool call whose page output was cut (ref `hermes:<tool row id>`). */
export function hermesToolOutput(path: string, session: string, ref: string): string | null {
  const match = HERMES_TOOL_REF.exec(ref);
  if (match === null || !SESSION_ID.test(session)) return null;
  try {
    return withStore(path, (db) => {
      const row = db.query<{ content: unknown }, [number, string]>("SELECT content FROM messages WHERE id = ? AND session_id = ? AND role = 'tool'").get(Number(match[1]), session);
      return row === null ? null : hermesToolResult(row.content).text;
    });
  } catch (error) {
    // a store held for a moment has no answer now: the next request finds it, where a failure would stick
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}
