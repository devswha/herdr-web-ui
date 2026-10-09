import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forgetHermesState, hermesContent, hermesConversation, hermesHomeRoots, hermesHomes, hermesReportedSession, hermesSessionForPane,
  hermesToolOutput, hermesToolResult, hermesTurns, type HermesAnswer, type HermesRow,
} from "./hermes.ts";
import type { ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-hermes-store-"));
const opened: Database[] = [];
// Windows refuses to delete a file a handle still holds
afterAll(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => forgetHermesState());

// The columns Hermes 2026.9.24 (schema 31) reads a conversation from, as it creates them (the
// many it keeps for accounting, search and gateways left out).
const SESSIONS = `CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, model_config TEXT, parent_session_id TEXT,
  started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, cwd TEXT, title TEXT, rewind_count INTEGER NOT NULL DEFAULT 0
)`;
const MESSAGES = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT,
  tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, finish_reason TEXT, reasoning TEXT, reasoning_content TEXT,
  _compressed_summary INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
  display_kind TEXT, display_metadata TEXT, display_order INTEGER
)`;
// what a store from before display grouping, rewinds and compaction kept
const LEGACY_MESSAGES = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
  tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL
)`;
const T0 = Date.parse("2026-10-09T09:00:00Z") / 1000;

let homes = 0;
type Message = Partial<{ role: string; content: string | null; tool_call_id: string; tool_calls: unknown; tool_name: string; reasoning: string; summary: number; active: number; compacted: number; display_kind: string; display_metadata: unknown; display_order: number; timestamp: number }>;

/** A Hermes home of its own with one session, and a writer that appends rows as Hermes does. */
function home(options: { session?: string; legacy?: boolean; profile?: string; base?: string; journal?: "wal" | "delete" } = {}) {
  const dir = options.base !== undefined && options.profile !== undefined ? join(options.base, "profiles", options.profile) : join(root, `home-${++homes}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.db");
  const db = new Database(path, { create: true });
  opened.push(db);
  db.exec(`PRAGMA journal_mode = ${options.journal ?? "wal"}`);
  db.exec(SESSIONS);
  db.exec(options.legacy ? LEGACY_MESSAGES : MESSAGES);
  const session = options.session ?? "20261009_090000_a1b2c3";
  const start = (id: string, extra: { ended?: boolean; rewinds?: number } = {}) => db.query("INSERT INTO sessions (id, source, model, model_config, started_at, ended_at, end_reason, cwd, rewind_count) VALUES (?, 'cli', 'example/model-1', ?, ?, ?, ?, '/work/demo', ?)")
    .run(id, JSON.stringify({ reasoning_config: { effort: "high" } }), T0, extra.ended ? T0 + 60 : null, extra.ended ? "new_session" : null, extra.rewinds ?? 0);
  start(session);
  let clock = T0;
  const add = (message: Message, to = session): number => {
    clock += 1;
    const columns: Record<string, unknown> = {
      session_id: to, role: message.role ?? "user", content: message.content ?? null, tool_call_id: message.tool_call_id ?? null,
      tool_calls: message.tool_calls === undefined ? null : JSON.stringify(message.tool_calls), tool_name: message.tool_name ?? null, timestamp: message.timestamp ?? clock,
    };
    if (!options.legacy) {
      Object.assign(columns, {
        reasoning: message.reasoning ?? null, _compressed_summary: message.summary ?? 0, active: message.active ?? 1, compacted: message.compacted ?? 0,
        display_kind: message.display_kind ?? null, display_metadata: message.display_metadata === undefined ? null : JSON.stringify(message.display_metadata),
      });
    }
    const names = Object.keys(columns);
    db.query(`INSERT INTO messages (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...(Object.values(columns) as (string | number | null)[]));
    const id = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    if (!options.legacy) db.query("UPDATE messages SET display_order = ? WHERE id = ?").run(message.display_order ?? id, id);
    return id;
  };
  const prompt = (text: string) => add({ role: "user", content: text });
  const call = (id: string, name: string, args: Record<string, unknown>, text = "") => add({ role: "assistant", content: text, tool_calls: [{ id, call_id: id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  const result = (id: string, name: string, content: string) => add({ role: "tool", content, tool_call_id: id, tool_name: name });
  const answer = (text: string) => add({ role: "assistant", content: text });
  return { dir, path, db, session, start, add, prompt, call, result, answer };
}

const page = (answer: HermesAnswer) => {
  if (answer.kind !== "page") throw new Error(`expected a page, got ${JSON.stringify(answer)}`);
  return answer;
};
const texts = (turns: ConversationTurn[]) => turns.map((turn) => `${turn.role}: ${turn.parts.map((part: ConversationPart) => part.kind === "text" ? part.text : part.kind === "tool" ? `[${part.name} ${part.summary} -> ${part.output}${part.error ? " !" : ""}]` : `<${part.kind}>`).join(" ")}`);
const row = (fields: Partial<HermesRow> & Pick<HermesRow, "id" | "role">): HermesRow => ({
  content: null, timestamp: T0 + fields.id, tool_call_id: null, tool_calls: null, reasoning: null, reasoning_content: null, display_kind: null, summary: 0, ...fields,
});

describe("hermesTurns", () => {
  it("makes a prompt, the calls that answer it and their results one assistant turn", () => {
    const turns = hermesTurns([
      row({ id: 1, role: "user", content: "Count the files" }),
      row({ id: 2, role: "assistant", content: "I'll look.", reasoning: "List them first.", tool_calls: JSON.stringify([{ id: "call_a", call_id: "call_a", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: "ls | wc -l" }) } }]) }),
      row({ id: 3, role: "tool", tool_call_id: "call_a", content: JSON.stringify({ output: "12", exit_code: 0, error: null }) }),
      row({ id: 4, role: "assistant", content: "There are **12** files." }),
    ]);
    expect(texts(turns)).toEqual(["user: Count the files", "assistant: <thinking> I'll look. [terminal ls | wc -l -> 12] There are **12** files."]);
    expect(turns[1]!.ts).toBe(new Date((T0 + 2) * 1000).toISOString());
    expect(turns[1]!.end_ts).toBe(new Date((T0 + 4) * 1000).toISOString());
  });

  it("marks a command that exited non-zero, and keeps the error a tool reported", () => {
    const turns = hermesTurns([
      row({ id: 1, role: "user", content: "Build it" }),
      row({ id: 2, role: "assistant", tool_calls: JSON.stringify([
        { id: "call_a", function: { name: "terminal", arguments: JSON.stringify({ command: "make" }) } },
        { id: "call_b", function: { name: "web_search", arguments: JSON.stringify({ query: "make error 2" }) } },
      ]) }),
      row({ id: 3, role: "tool", tool_call_id: "call_a", content: JSON.stringify({ output: "make: *** Error 2", exit_code: 2, error: null }) }),
      row({ id: 4, role: "tool", tool_call_id: "call_b", content: JSON.stringify({ success: false, error: "search is offline" }) }),
    ]);
    expect(texts(turns)).toEqual(["user: Build it", "assistant: [terminal make -> make: *** Error 2 !] [web_search make error 2 -> {\"success\":false,\"error\":\"search is offline\"} !]"]);
  });

  it("shows a runtime row as a notice, a steer as the user's words, a compaction as its summary, and nothing hidden", () => {
    const turns = hermesTurns([
      row({ id: 1, role: "user", content: "[Model switched to example/model-2]", display_kind: "model_switch" }),
      row({ id: 2, role: "user", content: "also check the tests", display_kind: "steer" }),
      row({ id: 3, role: "assistant", content: "", display_kind: "hidden" }),
      row({ id: 4, role: "user", content: "The user asked for a file count; it was 12.", summary: 1 }),
      row({ id: 5, role: "system", content: "You are Hermes." }),
    ]);
    expect(turns.map((turn) => [turn.role, turn.parts[0]])).toEqual([
      ["user", { kind: "notice", text: "[Model switched to example/model-2]", source: "model_switch" }],
      ["user", { kind: "text", text: "also check the tests" }],
      ["user", { kind: "compact", text: "The user asked for a file count; it was 12." }],
    ]);
  });

  it("reads list content behind Hermes's JSON marker, and a result for no call it knows is left out", () => {
    const turns = hermesTurns([
      row({ id: 1, role: "user", content: `\u0000json:${JSON.stringify([{ type: "text", text: "What is in this picture?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }])}` }),
      row({ id: 2, role: "tool", tool_call_id: "call_missing", content: "orphan" }),
      row({ id: 3, role: "assistant", content: "A cat." }),
    ]);
    expect(texts(turns)).toEqual(["user: What is in this picture?", "assistant: A cat."]);
    expect(hermesContent(`\u0000json:${JSON.stringify("\u0000json:literal")}`)).toBe("\u0000json:literal");
  });

  it("cuts a long output and names the row that holds the rest", () => {
    const long = "x".repeat(50_000);
    const turns = hermesTurns([
      row({ id: 1, role: "user", content: "Dump it" }),
      row({ id: 2, role: "assistant", tool_calls: JSON.stringify([{ id: "call_a", function: { name: "read_file", arguments: JSON.stringify({ path: "big.log" }) } }]) }),
      row({ id: 3, role: "tool", tool_call_id: "call_a", content: JSON.stringify({ content: long }) }),
    ]);
    const tool = turns[1]!.parts[0] as Extract<ConversationPart, { kind: "tool" }>;
    expect([tool.summary, tool.output_ref, tool.output_size, tool.output.endsWith("… trimmed")]).toEqual(["big.log", "hermes:3", 50_000, true]);
  });
});

describe("hermesToolResult", () => {
  it("unwraps a terminal result and leaves any other text as written", () => {
    expect(hermesToolResult(JSON.stringify({ output: "", exit_code: 1, error: "command not found" }))).toEqual({ text: "command not found", error: true });
    expect(hermesToolResult("plain text")).toEqual({ text: "plain text", error: false });
    expect(hermesToolResult(JSON.stringify([1, 2]))).toEqual({ text: "[1,2]", error: false });
  });
});

describe("hermesConversation", () => {
  it("reads a session, its model and its reasoning effort", () => {
    const store = home();
    store.prompt("Count the files");
    store.call("call_a", "terminal", { command: "ls | wc -l" }, "I'll look.");
    store.result("call_a", "terminal", JSON.stringify({ output: "12", exit_code: 0, error: null }));
    store.answer("There are 12 files.");
    const answer = page(hermesConversation(store.path, store.session));
    expect(texts(answer.turns)).toEqual(["user: Count the files", "assistant: I'll look. [terminal ls | wc -l -> 12] There are 12 files."]);
    expect(answer.metadata).toEqual({ model: "example/model-1", reasoning_effort: "high" });
    expect([answer.cursor, answer.history_id]).toEqual([null, `hermes-${store.session}`]);
  });

  it("shows each message once across compaction generations, and never a rewound or model-only one", () => {
    const store = home();
    const first = store.add({ role: "user", content: "First question", active: 0, compacted: 1 });
    store.add({ role: "assistant", content: "First answer", active: 0, compacted: 1 });
    const kept = store.add({ role: "user", content: "Second question", active: 0, compacted: 1 });
    store.add({ role: "assistant", content: "Undone answer", active: 0, compacted: 0 });
    // the compaction's summary and the protected tail copied into the live generation
    store.add({ role: "user", content: "Summary of the first question.", summary: 1 });
    store.add({ role: "user", content: "Second question", display_order: kept });
    store.add({ role: "user", content: "internal nudge", display_metadata: { model_only: true } });
    store.answer("Second answer");
    const answer = page(hermesConversation(store.path, store.session));
    expect(texts(answer.turns)).toEqual(["user: First question", "assistant: First answer", "user: Second question", "user: <compact>", "assistant: Second answer"]);
    expect(first).toBe(1);
  });

  it("reads a store from before display grouping and compaction", () => {
    const store = home({ legacy: true });
    store.prompt("Hello");
    store.answer("Hi there.");
    expect(texts(page(hermesConversation(store.path, store.session)).turns)).toEqual(["user: Hello", "assistant: Hi there."]);
  });

  it("pages back by prompts and refuses a cursor an undo removed", () => {
    const store = home();
    const prompts: number[] = [];
    for (let n = 1; n <= 60; n++) {
      prompts.push(store.prompt(`question ${n}`));
      store.answer(`answer ${n}`);
    }
    const newest = page(hermesConversation(store.path, store.session));
    expect(newest.turns.length).toBe(100);
    expect(texts(newest.turns)[0]).toBe("user: question 11");
    expect(newest.cursor).toBe(`hermes-${store.session}:${prompts[10]}`);
    const older = page(hermesConversation(store.path, store.session, { before: newest.cursor! }));
    expect(texts(older.turns)).toEqual(Array.from({ length: 10 }, (_, index) => [`user: question ${index + 1}`, `assistant: answer ${index + 1}`]).flat());
    expect(older.cursor).toBeNull();
    // a chat holding the newest page keeps its start while it is still in the newest page, and
    // gets the newest page once that moved past it
    store.answer("answer 60, continued");
    const held = page(hermesConversation(store.path, store.session, { from: newest.cursor! }));
    expect([texts(held.turns)[0], held.cursor]).toEqual(["user: question 11", newest.cursor]);
    store.prompt("question 61");
    const moved = page(hermesConversation(store.path, store.session, { from: newest.cursor! }));
    expect([texts(moved.turns)[0], texts(moved.turns).at(-1)]).toEqual(["user: question 12", "user: question 61"]);
    store.db.query("UPDATE messages SET active = 0 WHERE id = ?").run(prompts[10]!);
    expect(hermesConversation(store.path, store.session, { before: newest.cursor! })).toEqual({ kind: "history_changed" });
    expect(hermesConversation(store.path, store.session, { before: "hermes-other:1" })).toEqual({ kind: "history_changed" });
  });

  it("names a rewound session's history apart, so a chat reloads it", () => {
    const store = home();
    store.prompt("Hello");
    const before = page(hermesConversation(store.path, store.session)).history_id;
    store.db.query("UPDATE sessions SET rewind_count = 1 WHERE id = ?").run(store.session);
    expect([before, page(hermesConversation(store.path, store.session)).history_id]).toEqual([`hermes-${store.session}`, `hermes-${store.session}-r1`]);
  });

  it("answers a cached page until the session changes", () => {
    const store = home();
    store.prompt("Hello");
    const first = page(hermesConversation(store.path, store.session));
    expect(hermesConversation(store.path, store.session)).toBe(first);
    store.answer("Hi.");
    const second = page(hermesConversation(store.path, store.session));
    expect([second === first, second.signature === first.signature, texts(second.turns)]).toEqual([false, false, ["user: Hello", "assistant: Hi."]]);
  });

  it("is unavailable for a session the store does not hold, a missing store or one that is not Hermes's", () => {
    const store = home();
    expect(hermesConversation(store.path, "20261009_000000_ffffff")).toEqual({ kind: "unavailable", reason: "session_not_found" });
    expect(hermesConversation(join(root, "missing.db"), store.session)).toEqual({ kind: "unavailable", reason: "transcript_missing" });
    const other = join(root, "other.db");
    const db = new Database(other, { create: true });
    db.exec("CREATE TABLE notes (id INTEGER)");
    db.close();
    expect(hermesConversation(other, store.session)).toEqual({ kind: "unavailable", reason: "transcript_missing" });
    writeFileSync(join(root, "text.db"), "not a database");
    expect(hermesConversation(join(root, "text.db"), store.session)).toEqual({ kind: "unavailable", reason: "transcript_missing" });
    expect(hermesConversation(store.path, "../escape")).toEqual({ kind: "unavailable", reason: "no_session_id" });
  });

  it("gives a cut output whole by its row", () => {
    const store = home();
    store.prompt("Dump it");
    store.call("call_a", "terminal", { command: "cat big.log" });
    const id = store.result("call_a", "terminal", JSON.stringify({ output: "y".repeat(40_000), exit_code: 0, error: null }));
    expect(hermesToolOutput(store.path, store.session, `hermes:${id}`)?.length).toBe(40_000);
    expect(hermesToolOutput(store.path, store.session, "hermes:1")).toBeNull();
    expect(hermesToolOutput(store.path, store.session, "other:1")).toBeNull();
  });
});

describe("hermesSessionForPane", () => {
  const pane = (agent: string | null, reported: string | null): Pick<HerdrPane, "agent" | "agent_session"> => ({
    agent, agent_session: reported === null ? null : { agent: "hermes", kind: "id", source: "herdr:hermes", value: reported },
  });
  const lease = (dir: string, entries: { pid: number; session: string }[]) => {
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime", "active_sessions.json"), JSON.stringify({ entries: entries.map(({ pid, session }) => ({ lease_id: `lease-${pid}`, session_id: session, surface: "cli", pid, process_start_time: T0, started_at: T0, updated_at: T0 })) }));
  };

  it("follows herdr's report into the profile that holds the session", () => {
    const base = join(root, `base-${++homes}`);
    const main = home({ base, profile: "work", session: "20261009_100000_aaaaaa" });
    mkdirSync(base, { recursive: true });
    const homesFound = hermesHomes([base]);
    expect(homesFound).toEqual([base, main.dir]);
    expect(hermesSessionForPane(pane("hermes", main.session), [], homesFound)).toEqual({ kind: "session", path: main.path, session: main.session });
    // reported before its first prompt: nothing is written yet where the pane's Hermes runs
    lease(main.dir, [{ pid: 4242, session: "20261009_100500_bbbbbb" }]);
    expect(hermesSessionForPane(pane("hermes", "20261009_100500_bbbbbb"), [4242], homesFound)).toEqual({ kind: "unwritten", session: "20261009_100500_bbbbbb" });
    // a session no known home holds, from a Hermes no lease places: a home this server does not
    // know of may hold its whole history, so the terminal stands in rather than an empty chat
    expect(hermesSessionForPane(pane("hermes", "20261009_100500_bbbbbb"), [], homesFound)).toEqual({ kind: "unavailable", reason: "no_session_path" });
  });

  it("keeps a session whose store Hermes holds for a moment, and the page read before", () => {
    const store = home({ journal: "delete" });
    store.prompt("Hello");
    const before = page(hermesConversation(store.path, store.session));
    const writer = new Database(store.path);
    opened.push(writer);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      expect(hermesSessionForPane(pane("hermes", store.session), [], [store.dir])).toEqual({ kind: "session", path: store.path, session: store.session });
      expect(hermesConversation(store.path, store.session)).toBe(before);
    } finally { writer.exec("ROLLBACK"); }
  });

  it("finds the session a process in the pane leases, and nothing for a lease the pane does not hold", () => {
    const store = home();
    lease(store.dir, [{ pid: 4242, session: store.session }, { pid: 5151, session: "20261009_110000_cccccc" }]);
    expect(hermesSessionForPane(pane("hermes", null), [100, 4242], [store.dir])).toEqual({ kind: "session", path: store.path, session: store.session });
    expect(hermesSessionForPane(pane("hermes", null), [5151], [store.dir])).toEqual({ kind: "unwritten", session: "20261009_110000_cccccc" });
    expect(hermesSessionForPane(pane("hermes", null), [100], [store.dir])).toEqual({ kind: "unavailable", reason: "no_session_id" });
    // two sessions held by the pane's processes: no guess between them
    expect(hermesSessionForPane(pane("hermes", null), [4242, 5151], [store.dir])).toEqual({ kind: "unavailable", reason: "no_session_id" });
  });

  it("takes no leased session a /new ended, and no report a pane herdr does not call hermes left behind", () => {
    const store = home();
    store.start("20261009_120000_dddddd", { ended: true });
    lease(store.dir, [{ pid: 4242, session: "20261009_120000_dddddd" }]);
    expect(hermesSessionForPane(pane("hermes", null), [4242], [store.dir])).toEqual({ kind: "unavailable", reason: "no_session_id" });
    expect(hermesSessionForPane(pane(null, store.session), [], [store.dir])).toEqual({ kind: "unavailable", reason: "no_session_id" });
    // the report wins over a lease the CLI left on the session it ended
    expect(hermesSessionForPane(pane("hermes", store.session), [4242], [store.dir])).toEqual({ kind: "session", path: store.path, session: store.session });
  });

  it("reads only herdr's own Hermes report", () => {
    expect(hermesReportedSession({ agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "20261009_090000_a1b2c3" } })).toBe("20261009_090000_a1b2c3");
    expect(hermesReportedSession({ agent_session: { agent: "hermes", kind: "path", source: "herdr:hermes", value: "/tmp/x" } })).toBeNull();
    expect(hermesReportedSession({ agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "abc" } })).toBeNull();
    expect(hermesReportedSession({ agent_session: { agent: "hermes", kind: "id", source: "herdr:hermes", value: "../x" } })).toBeNull();
  });
});

describe("hermesHomeRoots", () => {
  it("finds the home where Hermes does: HERMES_HOME, else the platform's default", () => {
    expect(hermesHomeRoots({}, "/home/demo", "linux")).toEqual(["/home/demo/.hermes"]);
    expect(hermesHomeRoots({ HERMES_HOME: "~/agents/hermes" }, "/home/demo", "darwin")).toEqual(["/home/demo/agents/hermes", "/home/demo/.hermes"]);
    expect(hermesHomeRoots({ LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" }, "C:\\Users\\demo", "win32")[0]).toContain("hermes");
    expect(hermesHomeRoots({ HERMES_DATA_DIR_SUFFIX: "-dev" }, "/home/demo", "linux")).toEqual(["/home/demo/.hermes-dev"]);
  });
});
