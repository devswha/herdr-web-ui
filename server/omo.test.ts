import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldSessionIds, omoCandidates, selectOmoTranscript, type OmoRuntime } from "./omo.ts";

const runtime = (paneId: string, startedAt: number | null = 10_000, paths: string[] = [], ids: string[] = []): OmoRuntime => ({ paneId, startedAt, paths, ids });
const files = [
  { path: "/old.jsonl", id: "old-session", createdAt: 100 },
  { path: "/fresh.jsonl", id: "fresh-session", createdAt: 10_000 },
];

it("uses only a unique session created during the sole runtime, never cwd recency", () => {
  expect(selectOmoTranscript("a", files, [runtime("a")], 20_000)).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("b", 11_000)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("unreadable", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 10_000, [], ["missing-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 30_000)], 40_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a")], 5_000)).toBeNull();
  expect(selectOmoTranscript("a", [...files, { path: "/second.jsonl", id: "second", createdAt: 11_000 }], [runtime("a")], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", [{ ...files[1]!, createdAt: null }], [runtime("a")], 20_000)).toBeNull();
});

it("binds explicit sessions independently in one cwd but rejects conflicting claims", () => {
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/old.jsonl");
  expect(selectOmoTranscript("b", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"]), runtime("b", 20_000, [], ["fresh-session"])] )).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"], ["old-session"])] )).toBeNull();
});

it("reads session identity from bounded headers and rejects foreign cwd and escaped paths", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-omo-candidates-"));
  try {
    const dir = join(home, ".omo", "agent", "sessions", "--project--");
    mkdirSync(dir, { recursive: true });
    const session = (path: string, cwd: string) => writeFileSync(path, JSON.stringify({ type: "session", id: "session-1", cwd, timestamp: "2026-09-27T00:00:00Z" }) + "\n");
    session(join(dir, "valid.jsonl"), "/project");
    session(join(dir, "foreign.jsonl"), "/elsewhere");
    session(join(home, "outside.jsonl"), "/project");
    symlinkSync(join(home, "outside.jsonl"), join(dir, "escaped.jsonl"));
    writeFileSync(join(dir, "broken.jsonl"), "{");
    expect(omoCandidates("/project", home)).toEqual([{ path: join(dir, "valid.jsonl"), id: "session-1", createdAt: Date.parse("2026-09-27T00:00:00Z") }]);
    expect(omoCandidates("/missing", home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads only the live process's own holder records, never a reused pid's leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-omo-holders-"));
  try {
    const hold = (id: string, pid: number, processStartedAtMs: number) => {
      const holders = join(dir, "session-holders", encodeURIComponent(id));
      mkdirSync(holders, { recursive: true });
      writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs, cwd: "/project" }));
    };
    hold("current", 42, 10_000);
    hold("crashed-earlier", 42, 2_000);
    hold("another-process", 7, 10_000);
    hold("odd/id", 43, 10_000);
    expect(heldSessionIds(dir, 42, 10_900)).toEqual(["current"]);
    expect(heldSessionIds(dir, 42, null).sort()).toEqual(["crashed-earlier", "current"]);
    expect(heldSessionIds(dir, 43, 10_000)).toEqual(["odd/id"]);
    expect(heldSessionIds(dir, 99, 10_000)).toEqual([]);
    expect(heldSessionIds(join(dir, "missing"), 42, 10_000)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not pin a launch session id after a new unclaimed session appears", () => {
  const newer = [...files, { path: "/new.jsonl", id: "new-session", createdAt: 15_000 }];
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, ["/old.jsonl"], ["old-session"])], 20_000)).toBe("/old.jsonl");
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"]), runtime("b", 14_000, ["/new.jsonl"])], 20_000)).toBe("/old.jsonl");
});
