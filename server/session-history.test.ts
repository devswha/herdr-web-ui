import { afterAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionHistoryAgent, SessionSnapshot } from "../shared/protocol.ts";
import { HEAD_BYTES, listSessions, MAX_ENTRIES, MAX_ROWS, MAX_STATS, SESSION_HISTORY_AGENTS } from "./session-history.ts";
import { handleSessionHistoryRequest, workspaceFolder } from "./session-history-routes.ts";
import { claudeProjectDir } from "./claude-store.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "session-history");
const WINDOWS = process.platform === "win32";
const CWD = WINDOWS ? "C:\\work\\project" : "/work/project";
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** The folder each agent names after CWD, as the agent itself spells it. */
const FOLDERS: Partial<Record<SessionHistoryAgent, string>> = WINDOWS
  ? { claude: "C--work-project", pi: "--C--work-project--", omo: "--C--work-project--", omp: "--C--work-project--", gjc: "--C--work-project--", grok: "C%3A%5Cwork%5Cproject" }
  : { claude: "-work-project", pi: "--work-project--", omo: "--work-project--", omp: "--work-project--", gjc: "--work-project--", cmd: "work-project", grok: "%2Fwork%2Fproject" };
const EXPECTED: Record<SessionHistoryAgent, [string, string]> = {
  claude: [ID(2), ID(1)], codex: [ID(2), ID(1)], pi: [ID(2), ID(1)], omp: [ID(2), ID(1)], gjc: [ID(2), ID(1)], cmd: [ID(2), ID(1)],
  omo: [ID(2), ID(1)], grok: [ID(2), ID(1)], agy: [ID(2), ID(1)],
  opencode: ["ses_fixture0002", "ses_fixture0001"],
  hermes: ["20261002_090000_fx0002", "20261001_090000_fx0001"],
  devin: ["fixture-0002", "fixture-0001"],
};

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-session-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let homes = 0;
const newHome = () => { const home = join(root, `home-${++homes}`); mkdirSync(home); return home; };

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function install(agent: SessionHistoryAgent, home: string): void {
  const source = join(FIXTURES, agent);
  for (const file of filesUnder(source)) {
    const rel = relative(source, file).split(/[/\\]/).map((part, at) => part === "@folder" ? FOLDERS[agent]! : at === 0 && part.startsWith("dot-") ? `.${part.slice(4)}` : part);
    const target = join(home, ...rel);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(file, "utf8").replaceAll('"{{CWD}}"', JSON.stringify(CWD));
    if (target.endsWith(".sql")) {
      const db = new Database(target.replace(/\.sql$/, ".db"), { create: true });
      // one transaction: a statement each would sync the disk each time, seconds on a loaded machine
      db.transaction(() => db.exec(text.replaceAll(":cwd", sql(CWD)).replaceAll(":uris", sql(JSON.stringify([pathToFileURL(CWD).href])))))();
      db.close();
      continue;
    }
    writeFileSync(target, text);
    const seconds = Date.parse("2026-10-01T00:00:00Z") / 1000 + (/0002|0004/.test(target) ? 2000 : 1000);
    utimesSync(target, seconds, seconds);
  }
}

/** Whether this machine lets a test make symlinks (Windows needs Developer Mode or elevation). */
function canSymlink(): boolean {
  const probe = join(root, "probe-link");
  try { symlinkSync(root, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (WINDOWS && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
}
const SYMLINKS = canSymlink();

const piHeader = (id: string, cwd = CWD, padding = "") => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T09:00:00.000Z", cwd, ...(padding ? { padding } : {}) })}\n`;
const piPrompt = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;
const piStore = (home: string) => join(home, ".pi", "agent", "sessions", FOLDERS.pi!);

describe("listSessions", () => {
  for (const agent of SESSION_HISTORY_AGENTS) {
    // Command Code's slug keeps a Windows drive's colon, which no Windows folder name may hold
    it.skipIf(agent === "cmd" && WINDOWS)(`lists ${agent}'s own sessions of the folder, newest first, with its resume command`, () => {
      const home = newHome();
      install(agent, home);
      const rows = listSessions(agent, CWD, { home, env: {} });
      expect(rows.map((row) => row.id)).toEqual(EXPECTED[agent]);
      expect(rows.map((row) => row.firstMessage)).toEqual([`Fixture ${agent} prompt 2`, `Fixture ${agent} prompt 1`]);
      for (const row of rows) {
        expect(row.resume?.argv[0]).toBe(agent);
        expect(row.resume?.argv.at(-1)).toBe(row.id);
        expect(row.startedAt).not.toBeNull();
        expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
      }
      expect(Date.parse(rows[0]!.updatedAt)).toBeGreaterThan(Date.parse(rows[1]!.updatedAt));
    });
  }

  it("lists nothing from a store that is not there", () => {
    const home = newHome();
    for (const agent of SESSION_HISTORY_AGENTS) expect(listSessions(agent, CWD, { home, env: {} })).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("refuses a session file or folder that a link puts outside the store", () => {
    const home = newHome();
    install("pi", home);
    const outside = join(root, `outside-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "escaped.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    symlinkSync(join(outside, "escaped.jsonl"), join(piStore(home), "escaped.jsonl"));
    install("codex", home);
    mkdirSync(join(outside, "day"));
    writeFileSync(join(outside, "day", `rollout-2026-10-09T09-00-00-${ID(9)}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: ID(9), cwd: CWD, source: "cli" } })}\n`);
    symlinkSync(join(outside, "day"), join(home, ".codex", "sessions", "2026", "10", "09"), "dir");
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id)).toEqual(EXPECTED.pi);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => row.id)).toEqual(EXPECTED.codex);
  });

  it(`returns at most ${MAX_ROWS} sessions, the newest`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ROWS + 10; n++) {
      const path = join(piStore(home), `session-${String(n).padStart(3, "0")}.jsonl`);
      writeFileSync(path, piHeader(`session-${n}`) + piPrompt(`prompt ${n}`));
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
    }
    const rows = listSessions("pi", CWD, { home, env: {} });
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[0]!.id).toBe(`session-${MAX_ROWS + 9}`);
    expect(rows.at(-1)!.id).toBe("session-10");
  });

  it("reads only the head of a 10 MB session file", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const path = join(piStore(home), "large.jsonl");
    writeFileSync(path, piHeader(ID(5)) + piPrompt("large prompt") + `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(10 * 1024 * 1024) } })}\n`);
    expect(statSync(path).size).toBeGreaterThan(10 * 1024 * 1024);
    let bytes = 0;
    const rows = listSessions("pi", CWD, {
      home, env: {},
      readHead: (fd, max) => {
        const buffer = Buffer.alloc(max);
        const read = readSync(fd, buffer, 0, max, 0);
        bytes += read;
        return buffer.subarray(0, read);
      },
    });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(5), "large prompt"]]);
    expect(bytes).toBe(HEAD_BYTES);
  });

  it("lists a Codex rollout whose header outgrows the read", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-10-01T09-00-00-${ID(1)}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: ID(1), timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD, source: "cli", base_instructions: { text: "i".repeat(2 * HEAD_BYTES) } } })}\n`);
    const rows = listSessions("codex", CWD, { home, env: {} });
    expect(rows.map((row) => [row.id, row.firstMessage, row.resume?.argv])).toEqual([[ID(1), null, ["codex", "resume", ID(1)]]]);
  });

  it.skipIf(!SYMLINKS)("refuses a SQLite store that a link puts outside the store", () => {
    for (const [agent, dir, db] of [["hermes", [".hermes"], "state.db"], ["opencode", [".local", "share", "opencode"], "opencode.db"]] as const) {
      const home = newHome();
      install(agent, home);
      const outside = join(root, `outside-db-${homes}`);
      mkdirSync(outside);
      renameSync(join(home, ...dir, db), join(outside, db));
      symlinkSync(join(outside, db), join(home, ...dir, db));
      expect(listSessions(agent, CWD, { home, env: {} })).toEqual([]);
    }
  });

  it(`looks at no more than ${MAX_STATS} paths for one listing`, () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    for (let n = 0; n < MAX_STATS + 50; n++) {
      const dir = join(group, `session-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `session-${n}`, cwd: CWD }, updated_at: "2026-10-01T09:00:00Z" }));
    }
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path) => { stats++; return statSync(path); } });
    expect(stats).toBeGreaterThan(MAX_ROWS);
    expect(stats).toBeLessThanOrEqual(MAX_STATS);
    expect(rows).toHaveLength(MAX_ROWS);
  });

  it.skipIf(!SYMLINKS)(`counts every path resolution against the ${MAX_STATS} checks, whether it resolves, fails or lands outside`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-links-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "elsewhere.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    for (let n = 0; n < 2000; n++) symlinkSync(join(outside, `gone-${n}.jsonl`), join(piStore(home), `dangling-${String(n).padStart(4, "0")}.jsonl`));
    for (let n = 0; n < 100; n++) symlinkSync(join(outside, "elsewhere.jsonl"), join(piStore(home), `outside-${n}.jsonl`));
    let resolutions = 0;
    let stats = 0;
    const rows = listSessions("pi", CWD, {
      home, env: {},
      resolve: (path) => { resolutions++; return realpathSync(path); },
      stat: (path) => { stats++; return statSync(path); },
    });
    expect(rows).toEqual([]);
    expect(resolutions).toBeGreaterThan(MAX_ROWS);
    expect(resolutions + stats).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a session file swapped for a link out of the store after it was checked", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-swap-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const rows = listSessions("pi", CWD, {
      home, env: {},
      // the file is checked, then swapped for a link out of the store before it is opened
      stat: (path) => {
        const stat = statSync(path);
        if (path === checked) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  // a session file is one check (its resolution with its stat). On Windows a session of another
  // folder also spends two on its folder's file IDs, so this many of them would use the budget there
  it.skipIf(WINDOWS)("lists a folder's older Codex rollouts behind about 300 newer rollouts of other folders", () => {
    const home = newHome();
    const rollout = (day: string, n: number, at: number, cwd: string) => {
      const dir = join(home, ".codex", "sessions", "2026", "10", day);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-10-${day}T09-00-00-${n.toString(16).padStart(12, "0")}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, cwd, source: "cli" } })}\n`);
      utimesSync(path, at, at);
    };
    for (let n = 0; n < 300; n++) rollout(String(20 + (n % 3)), 0x1000 + n, 1_790_100_000 + n, "/elsewhere");
    rollout("01", 1, 1_790_000_000, CWD);
    rollout("01", 2, 1_790_000_001, CWD);
    let resolutions = 0;
    const rows = listSessions("codex", CWD, { home, env: {}, resolve: (path) => { resolutions++; return realpathSync(path); } });
    expect(rows.map((row) => row.id)).toEqual([ID(2), ID(1)]);
    expect(resolutions).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a SQLite store swapped for a link to another database after it was checked", () => {
    const home = newHome();
    install("hermes", home);
    const elsewhere = newHome();
    install("hermes", elsewhere);
    const outside = new Database(join(elsewhere, ".hermes", "state.db"));
    outside.exec("UPDATE messages SET content = 'outside the store' WHERE role = 'user'");
    outside.close();
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    let swapped = false;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // the database is checked, then swapped for a link to another one before it is opened
      stat: (path) => {
        const stat = statSync(path);
        if (path === checked && !swapped) { swapped = true; rmSync(path); symlinkSync(join(elsewhere, ".hermes", "state.db"), path); }
        return stat;
      },
    });
    expect(swapped).toBe(true);
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("gives a reader only the checked file, so no reader can read a file swapped in after the check", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-reader-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const rows = listSessions("pi", CWD, {
      home, env: {},
      stat: (path) => {
        const stat = statSync(path);
        if (path === checked) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
      // a reader that does no check of its own: given a path it would follow the link
      readHead: ((target: number | string, max: number) => typeof target === "number"
        ? (() => { const buffer = Buffer.alloc(max); return buffer.subarray(0, readSync(target, buffer, 0, max, 0)); })()
        : readFileSync(target).subarray(0, max)) as never,
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  it(`reads at most ${MAX_ENTRIES} entries of a folder, however many it holds`, () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ENTRIES + 500; n++) writeFileSync(join(piStore(home), `s-${n}.jsonl`), "");
    let looked = 0;
    try {
      listSessions("pi", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    } finally {
      // removed here, inside this test's own time: on NTFS making and removing them takes seconds
      rmSync(home, { recursive: true, force: true });
    }
    expect(looked).toBeGreaterThan(MAX_STATS);
    expect(looked).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 60_000);

  it(`lists the newest sessions of a folder that holds more than ${MAX_STATS}, whatever their names`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // Claude names a session by a random id: the names say nothing of the times
    const written: { id: string; at: number }[] = [];
    for (let n = 0; n < 500; n++) {
      const id = `${(n * 7919 % 500).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
      written.push({ id, at: n });
    }
    const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
    expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
  });

  // more entries than the 4096 the listing once took: which ones it saw followed readdir order
  for (const [count, folders] of [[2500, true], [5000, false]] as const) {
    it(`keeps the newest ${MAX_ROWS} of ${count} Claude sessions${folders ? " with their per-session folders" : ""}, whatever the readdir order`, () => {
      const home = newHome();
      const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
      mkdirSync(project, { recursive: true });
      const written: { id: string; at: number }[] = [];
      for (let n = 0; n < count; n++) {
        const id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
        const path = join(project, `${id}.jsonl`);
        writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
        // the times follow neither the names nor the order the files were made in
        const at = (n * 7919) % count;
        utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
        // Claude keeps a folder of subagent transcripts beside a session
        if (folders) mkdirSync(join(project, id));
        written.push({ id, at });
      }
      const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
      expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
    }, 30_000);
  }

  it("checks the Grok session written last first, by its files' times rather than its folder's", () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    const session = (id: string, updated: number, folder: number) => {
      const dir = join(group, id);
      mkdirSync(dir, { recursive: true });
      for (const name of ["summary.json", "updates.jsonl"]) {
        const path = join(dir, name);
        writeFileSync(path, name === "summary.json" ? JSON.stringify({ info: { id, cwd: CWD }, updated_at: new Date(updated * 1000).toISOString() }) : "");
        utimesSync(path, updated, updated);
      }
      // a folder's time moves when a file is made in it, not while a session keeps writing to one
      utimesSync(dir, folder, folder);
    };
    for (let n = 0; n < 300; n++) session(`idle-${n}`, 1_790_000_000 + n, 1_790_500_000 + n);
    session("active", 1_790_900_000, 1_789_000_000);
    expect(listSessions("grok", CWD, { home, env: {} })[0]?.id).toBe("active");
  });

  it("lists a hashed Grok group's session folders once", () => {
    const home = newHome();
    for (let n = 0; n < 100; n++) {
      const dir = join(home, ".grok", "sessions", "long-slug-abc123", `s-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `s-${n}`, cwd: CWD }, updated_at: "2026-10-01T10:00:00Z" }));
      writeFileSync(join(dir, "updates.jsonl"), "");
    }
    let looked = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    expect(rows).toHaveLength(MAX_ROWS);
    // two files' times for each of the 100 folders, taken once
    expect(looked).toBe(200);
  });

  it("finds Grok sessions in a native hashed cwd group", () => {
    const home = newHome();
    const dir = join(home, ".grok", "sessions", "long-slug-abc123", ID(7));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: ID(7), cwd: CWD }, created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T10:00:00Z" }));
    const other = join(home, ".grok", "sessions", "other-slug-def456", ID(8));
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "summary.json"), JSON.stringify({ info: { id: ID(8), cwd: "/elsewhere" }, updated_at: "2026-10-01T10:00:00Z" }));
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(7)]);
  });

  const grokSession = (group: string, id: string, cwd: string, home: string) => {
    const dir = join(home, ".grok", "sessions", group, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id, cwd }, updated_at: "2026-10-01T10:00:00Z" }));
  };

  it("spends no stats on the sessions of another folder's Grok group", () => {
    const home = newHome();
    for (let n = 0; n < MAX_STATS + 10; n++) grokSession("foreign-slug-aaa111", `foreign-${n}`, "/elsewhere", home);
    grokSession("target-slug-bbb222", ID(7), CWD, home);
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path) => { stats++; return statSync(path); } });
    expect(rows.map((row) => row.id)).toEqual([ID(7)]);
    expect(stats).toBeLessThan(20);
  });

  it("reads the cwd's own Grok group even when the store holds too many groups to list", () => {
    const home = newHome();
    for (let n = 0; n <= 4096; n++) mkdirSync(join(home, ".grok", "sessions", `empty-${n}`), { recursive: true });
    grokSession(FOLDERS.grok!, ID(6), CWD, home);
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(6)]);
  });

  it.skipIf(!SYMLINKS)("checks a folder's identity under Windows rules within the counted stat budget", () => {
    const home = newHome();
    const real = join(root, `real-${homes}`);
    mkdirSync(real);
    const alias = join(root, `alias-${homes}`);
    symlinkSync(real, alias, WINDOWS ? "junction" : "dir");
    for (let n = 0; n < 5; n++) grokSession(encodeURIComponent(real), `alias-${n}`, alias, home);
    let stats = 0;
    const rows = listSessions("grok", real, {
      home, env: {}, platform: "win32",
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows).toHaveLength(5);
    // the store, five summaries, and both folders of each of the five sessions
    expect(stats).toBe(1 + 5 + 5 * 2);
  });

  for (const [name, cwd, spelling] of [
    ["a drive letter in another case", "C:\\work\\project", "c:\\work\\project"],
    ["a verbatim drive prefix", "C:\\work\\project", "\\\\?\\C:\\work\\project"],
    ["a verbatim UNC prefix", "\\\\server\\share\\project", "\\\\?\\UNC\\server\\share\\project"],
  ] as const) {
    it(`reads a Grok group named after the same Windows folder with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(5), spelling, home);
      expect(listSessions("grok", cwd, { home, env: {} }).map((row) => row.id)).toEqual([ID(5)]);
    });
  }

  for (const [name, spelling] of [
    ["forward slashes", "C:/work/project"],
    ["a trailing separator", "C:\\work\\project\\"],
    ["mixed separators", "C:\\work/project"],
  ] as const) {
    it(`reads a Grok group of the same Windows folder spelled with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(4), spelling, home);
      expect(listSessions("grok", "C:\\work\\project", { home, env: {}, platform: "win32" }).map((row) => row.id)).toEqual([ID(4)]);
    });
  }

  it("reads the Grok group of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const long = "C:\\Program Files\\Project Folder";
    grokSession(encodeURIComponent(long), ID(3), long, home);
    const resolved: string[] = [];
    let stats = 0;
    const rows = listSessions("grok", "C:\\PROGRA~1\\PROJEC~1", {
      home, env: {}, platform: "win32",
      realpath: (path) => { resolved.push(path); return path === "C:\\PROGRA~1\\PROJEC~1" ? long : path; },
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual(["C:\\PROGRA~1\\PROJEC~1"]);
    // stat calls: the store and the session's summary (the one resolution is budgeted, through realpath)
    expect(stats).toBe(2);
  });

  const SHORT = "C:\\PROGRA~1\\PROJEC~1";
  const LONG = "C:\\Program Files\\Project Folder";
  const shortAlias = (resolved: string[]) => (path: string) => { resolved.push(path); return path === SHORT ? LONG : path; };

  it("finds Claude's project of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(LONG));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${ID(2)}.jsonl`), `${JSON.stringify({ type: "user", cwd: LONG, timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "long-name prompt" } })}\n`);
    const resolved: string[] = [];
    const rows = listSessions("claude", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(2), "long-name prompt"]]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds a pi session folder of a Windows short-name cwd's long name", () => {
    const home = newHome();
    const folder = join(home, ".pi", "agent", "sessions", "--C--Program Files-Project Folder--");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "long.jsonl"), piHeader(ID(3), LONG) + piPrompt("long-name prompt"));
    const resolved: string[] = [];
    expect(listSessions("pi", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) }).map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds omp's temp-scoped folder when TEMP is a Windows short-name alias of the cwd's base", () => {
    const home = newHome();
    const shortTemp = "C:\\Users\\LONGUS~1\\AppData\\Local\\Temp";
    const longTemp = "C:\\Users\\Long User Name\\AppData\\Local\\Temp";
    const cwd = `${longTemp}\\project`;
    const folder = join(home, ".omp", "agent", "sessions", "-tmp-project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "scoped.jsonl"), piHeader(ID(8), cwd) + piPrompt("temp-scoped prompt"));
    const resolved: string[] = [];
    const rows = listSessions("omp", cwd, {
      home, env: {}, platform: "win32", tmpdir: shortTemp,
      realpath: (path) => { resolved.push(path); return path === shortTemp ? longTemp : path; },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(8)]);
    expect(resolved.sort()).toEqual([cwd, home, shortTemp].sort());
  });

  for (const [agent, store] of [["omp", ".omp"], ["gjc", ".gjc"]] as const) {
    it.skipIf(!SYMLINKS || WINDOWS)(`lists ${agent}'s session recorded under the canonical folder of a cwd reached through a link`, () => {
      const home = newHome();
      // macOS's /var -> /private/var: the pane names the link, the agent records the folder it resolves to
      const privateVar = join(root, `private-${homes}`, "var");
      mkdirSync(join(privateVar, "project"), { recursive: true });
      const link = join(root, `var-${homes}`);
      symlinkSync(privateVar, link, "dir");
      const canonical = join(privateVar, "project");
      const folder = join(home, store, "agent", "sessions", `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "linked.jsonl"), piHeader(ID(9), canonical) + piPrompt("linked prompt"));
      const options = { home, env: {}, tmpdir: join(root, "no-temp-scope") };
      expect(listSessions(agent, canonical, options).map((row) => row.id)).toEqual([ID(9)]);
      expect(listSessions(agent, join(link, "project"), options).map((row) => row.id)).toEqual([ID(9)]);
    });
  }

  it("lists a pi session only in a layout version pi documents", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const header = (id: string, version?: number) => `${JSON.stringify({ type: "session", ...(version === undefined ? {} : { version }), id, timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD })}\n`;
    writeFileSync(join(piStore(home), "future.jsonl"), header("future", 999) + piPrompt("future"));
    writeFileSync(join(piStore(home), "v1.jsonl"), header("v1") + piPrompt("v1"));
    writeFileSync(join(piStore(home), "v2.jsonl"), header("v2", 2) + piPrompt("v2"));
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id).sort()).toEqual(["v1", "v2"]);
  });

  it("puts the most recently written session first, whatever its file name", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (const [name, seconds] of [["2026-10-01T09-00-00_a.jsonl", 1_790_000_300], ["2026-10-02T09-00-00_b.jsonl", 1_790_000_100], ["2026-10-03T09-00-00_c.jsonl", 1_790_000_200]] as const) {
      const path = join(piStore(home), name);
      writeFileSync(path, piHeader(name) + piPrompt(name));
      utimesSync(path, seconds, seconds);
    }
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => row.id)).toEqual(["2026-10-01T09-00-00_a.jsonl", "2026-10-03T09-00-00_c.jsonl", "2026-10-02T09-00-00_b.jsonl"]);
  });

  it("gives no resume command for an id that could be read as an option", () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    writeFileSync(join(piStore(home), "flag.jsonl"), piHeader("--yolo") + piPrompt("flag"));
    expect(listSessions("pi", CWD, { home, env: {} }).map((row) => [row.id, row.resume])).toEqual([["--yolo", null]]);
  });
});

const snapshot = (worktree: string | null = null): Pick<SessionSnapshot, "workspaces" | "tabs" | "panes"> => ({
  workspaces: [{ workspace_id: "w1", ...(worktree ? { worktree: { checkout_path: worktree, is_linked_worktree: true, repo_key: "", repo_name: "", repo_root: "" } } : {}) }],
  tabs: [{ tab_id: "t2", workspace_id: "w1", number: 2 }, { tab_id: "t1", workspace_id: "w1", number: 1 }],
  panes: [{ pane_id: "p2", tab_id: "t2", workspace_id: "w1", cwd: "/second" }, { pane_id: "p1", tab_id: "t1", workspace_id: "w1", cwd: CWD }],
} as unknown as Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">);

describe("GET /api/sessions/history", () => {
  const request = (query: string) => {
    const url = new URL(`http://localhost/api/sessions/history?${query}`);
    return [new Request(url), url] as const;
  };

  it("names the workspace's worktree checkout, else its first tab's folder", () => {
    expect(workspaceFolder(snapshot(), "w1")).toBe(CWD);
    expect(workspaceFolder(snapshot("/checkout"), "w1")).toBe("/checkout");
    expect(workspaceFolder(snapshot(), "w9")).toBeNull();
  });

  it("lists the workspace folder's sessions", async () => {
    const home = newHome();
    install("codex", home);
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { cwd: string; sessions: { id: string; resume: { argv: string[] } | null }[] };
    expect(body.cwd).toBe(CWD);
    expect(body.sessions.map((row) => row.resume?.argv)).toEqual(EXPECTED.codex.map((id) => ["codex", "resume", id]));
  });

  it("refuses a device that may only watch", async () => {
    let asked = false;
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: true, snapshot: async () => { asked = true; return snapshot(); } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("read_only");
    expect(asked).toBe(false);
  });

  it("refuses an unknown agent, a missing or unknown workspace", async () => {
    const options = { readOnly: false, snapshot: async () => snapshot() };
    const codes = async (query: string) => {
      const response = await handleSessionHistoryRequest(...request(query), options);
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };
    expect(await codes("workspace_id=w1&agent=bash")).toEqual([400, "invalid_agent"]);
    expect(await codes("agent=codex")).toEqual([400, "missing_workspace_id"]);
    expect(await codes("workspace_id=w9&agent=codex")).toEqual([404, "workspace_not_found"]);
  });
});
