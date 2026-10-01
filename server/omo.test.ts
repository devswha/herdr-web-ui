import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldSessionIds, isOmoProcess, omoCandidates, selectOmoTranscript, type OmoRuntime } from "./omo.ts";

const runtime = (paneId: string, startedAt: number | null = 10_000, paths: string[] = [], ids: string[] = []): OmoRuntime => ({ paneId, startedAt, paths, ids });
const files = [
  { path: "/old.jsonl", id: "old-session", createdAt: 100 },
  { path: "/fresh.jsonl", id: "fresh-session", createdAt: 10_000 },
];

const OMO_AI = "/home/u/.nvm/versions/node/v24.18.0/lib/node_modules/omo-ai";

it("takes omo from the program a process runs: its own binary, or the script of node or bun", () => {
  // argv as herdr 0.9.0's pane.process_info reported them for omo 5.1.7 and its MCP child
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${OMO_AI}/plugin`])).toBeTrue();
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/plugin/runtime/ast-grep-mcp/cli.js`, "mcp"])).toBeTrue();
  expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue();
  expect(isOmoProcess(["node", "--enable-source-maps", `${OMO_AI}/bin/omo.js`, "--session-id", "abcdefgh"])).toBeTrue();
  expect(isOmoProcess(["omo"])).toBeTrue();
  expect(isOmoProcess(["/home/u/.local/bin/omo", "--session-id", "abcdefgh"])).toBeTrue();
  expect(isOmoProcess([`${OMO_AI}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, "--output-format", "stream-json"])).toBeTrue();
});

it("does not take an omo path given to another program for omo", () => {
  expect(isOmoProcess(["grep", "-q", `${OMO_AI}/x`])).toBeFalse();
  expect(isOmoProcess(["cat", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse();
  expect(isOmoProcess(["ls", "omo"])).toBeFalse();
  expect(isOmoProcess(["node", "/home/u/tools/watch.js", `${OMO_AI}/plugin`])).toBeFalse();
  expect(isOmoProcess(["bun", "--version"])).toBeFalse();
  expect(isOmoProcess(["/home/u/omo-ai-tools/bun", "/home/u/x.js"])).toBeFalse();
  expect(isOmoProcess([])).toBeFalse();
});

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
  // candidates come back canonical; macOS's tmpdir is a symlink into /private
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-candidates-")));
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
