import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { forgetTranscriptState } from "./conversation.ts";
import { boundGjcTranscript, gjcBreadcrumbPath, gjcDisplayCandidates, gjcPidUnderShell, gjcSessionFile, isGjcProcess, matchGjcTranscript, parseGjcPs, recentProcessTable, storeRelative } from "./gjc-runtime.ts";

// Session paths come back canonical and the store root is passed in canonical; macOS's tmpdir is a symlink into /private.
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

it("recognizes native and interpreter-launched gjc, not look-alikes", () => {
  expect(isGjcProcess(["/home/u/.local/bin/gjc", "--resume"])).toBe(true);
  expect(isGjcProcess(["gjc"])).toBe(true);
  expect(isGjcProcess(["/usr/bin/node", "/opt/gjc/dist/gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["bun", "./gjc.js"])).toBe(true);
  expect(isGjcProcess(["/bin/zsh"])).toBe(false);
  expect(isGjcProcess(["gjc-helper"])).toBe(false);
  expect(isGjcProcess(["node", "/tmp/gjc/server.js"])).toBe(false);
  expect(isGjcProcess([])).toBe(false);
});

it("reads macOS terminal/process identity without /proc", () => {
  expect(parseGjcPs("ttys003 Mon Sep 28 10:00:00 2026\n")?.id).toBe("ttys003");
  expect(parseGjcPs("?? Mon Sep 28 10:00:00 2026")).toBeNull();
  expect(parseGjcPs("ttys003 invalid")).toBeNull();
});

it("validates breadcrumbs against process age, canonical cwd and the native session store", () => {
  const home = tempDir("gjc-breadcrumb-");
  try {
    // GJC's layout: one store directory per project under sessions/
    const store = join(home, ".gjc/agent/sessions/v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(store, { recursive: true }); mkdirSync(markers);
    const path = join(store, "session.jsonl"), marker = join(markers, "ttys003");
    writeFileSync(path, JSON.stringify({ type: "session", cwd: home }) + "\n");
    writeFileSync(marker, `${home}\n${path}\n`);
    expect(gjcBreadcrumbPath(home, home, "ttys003", Date.now() - 1000)).toBe(path);
    expect(gjcBreadcrumbPath(home, "/", "ttys003", 0)).toBeNull();
    expect(gjcBreadcrumbPath(home, home, "../sessions/session.jsonl", 0)).toBeNull();
    utimesSync(marker, new Date(0), new Date(0));
    expect(gjcBreadcrumbPath(home, home, "ttys003", Date.now())).toBeNull();
    const outside = join(home, "outside.jsonl"), escape = join(store, "escape.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", cwd: home })); symlinkSync(outside, escape);
    writeFileSync(marker, `${home}\n${escape}\n`);
    expect(gjcBreadcrumbPath(home, home, "ttys003", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a breadcrumb left on a subagent's file as the session that ran it", () => {
  const home = tempDir("gjc-subagent-");
  try {
    const root = join(home, ".gjc/agent/sessions"), store = join(root, "v2-project");
    const markers = join(home, ".gjc/agent/terminal-sessions");
    mkdirSync(join(store, "2026-09-29_session"), { recursive: true }); mkdirSync(markers, { recursive: true });
    const header = JSON.stringify({ type: "session", cwd: home }) + "\n";
    const session = join(store, "2026-09-29_session.jsonl"), subagent = join(store, "2026-09-29_session", "2-Worker.jsonl");
    writeFileSync(session, header); writeFileSync(subagent, header);
    writeFileSync(join(markers, "pts-3"), `${home}\n${subagent}\n`);
    expect(gjcBreadcrumbPath(home, home, "pts-3", 0)).toBe(session);
    expect(gjcSessionFile(root, session)).toBe(session);
    expect(gjcSessionFile(root, subagent)).toBe(session);
    // a subagent whose session file is gone, or any other depth, stands for nothing
    rmSync(session);
    expect(gjcBreadcrumbPath(home, home, "pts-3", 0)).toBeNull();
    expect(gjcSessionFile(root, subagent)).toBeNull();
    expect(gjcSessionFile(root, join(root, "top.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "a", "b", "c.jsonl"))).toBeNull();
    expect(gjcSessionFile(root, join(store, "notes.txt"))).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads a store on a Windows PC, where paths come with backslashes", () => {
  const root = "C:\\Users\\u\\.gjc\\agent\\sessions";
  const session = `${root}\\v2-project\\2026-10-01_session.jsonl`;
  expect(gjcSessionFile(root, session, win32)).toBe(session);
  // what gjcDisplayCandidates asks of every file it lists
  expect(storeRelative(root, session, win32)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
  // the drive letter's case is not a different place there
  expect(gjcSessionFile(root, `c${session.slice(1)}`, win32)).toBe(`c${session.slice(1)}`);
  for (const outside of [
    `${root}-evil\\v2-project\\session.jsonl`,
    `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`,
    `${root}\\v2-project\\..\\..\\..\\elsewhere\\session.jsonl`,
    `D:${session.slice(2)}`,
    `\\\\server\\share\\.gjc\\agent\\sessions\\v2-project\\session.jsonl`,
    root,
  ]) {
    expect(storeRelative(root, outside, win32)).toBeNull();
    expect(gjcSessionFile(root, outside, win32)).toBeNull();
  }
  expect(gjcSessionFile(root, `${root}\\top.jsonl`, win32)).toBeNull();
  expect(gjcSessionFile(root, `${root}\\v2-project\\notes.txt`, win32)).toBeNull();
  // a name that only starts with two dots is a name, not the way out
  expect(storeRelative(root, `${root}\\..project\\session.jsonl`, win32)).toEqual(["..project", "session.jsonl"]);
});

it("refuses a path that leaves the store on Linux and macOS too", () => {
  const root = "/home/u/.gjc/agent/sessions";
  expect(storeRelative(root, `${root}/v2-project/session.jsonl`)).toEqual(["v2-project", "session.jsonl"]);
  expect(storeRelative(root, `${root}-evil/v2-project/session.jsonl`)).toBeNull();
  expect(storeRelative(root, `${root}/../sessions-evil/v2-project/session.jsonl`)).toBeNull();
  expect(gjcSessionFile(root, `${root}/../sessions-evil/session.jsonl`)).toBeNull();
});

it("finds gjc under a Windows pane's shell, the only process herdr names there", async () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const gjc = "C:\\Users\\u\\AppData\\Local\\gjc\\gjc.exe";
  const rows = [
    { pid: 100, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 101, parent: 4, path: powershell, commandLine: "powershell.exe" },
    { pid: 150, parent: 100, path: "C:\\Windows\\System32\\conhost.exe", commandLine: "conhost.exe" },
    // gjc's own helper, a child of the session's process (seen on a real PC)
    { pid: 300, parent: 200, path: gjc, commandLine: `${gjc} sdk broker-internal` },
    { pid: 200, parent: 100, path: gjc, commandLine: `"${gjc}" --resume` },
  ];
  const table = async () => rows;
  expect(await gjcPidUnderShell(100, "win32", table)).toBe(200);
  // another pane's shell on the same PC does not run it
  expect(await gjcPidUnderShell(101, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(undefined, "win32", table)).toBeNull();
  // elsewhere herdr's foreground processes are the answer and the table is never asked
  let asked = false;
  expect(await gjcPidUnderShell(100, "linux", async () => { asked = true; return rows; })).toBeNull();
  expect(asked).toBe(false);
});

it("keeps a Windows pane on the session its screen once showed, while the same gjc runs there", async () => {
  forgetTranscriptState();
  const file = "C:\\Users\\u\\.gjc\\agent\\sessions\\v2-project\\one.jsonl";
  const other = "C:\\Users\\u\\.gjc\\agent\\sessions\\v2-project\\two.jsonl";
  const offScreen = async () => null;
  // a running gjc alone names no session: the first answer needs the screen
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBeNull();
  expect(await boundGjcTranscript("w1:p1", 200, async () => file)).toBe(file);
  // a long answer pushed every answer's tail off the screen
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBe(file);
  expect(await boundGjcTranscript("w1:p2", 200, offScreen)).toBeNull();
  // the same process shows another session (/resume): the screen wins
  expect(await boundGjcTranscript("w1:p1", 200, async () => other)).toBe(other);
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBe(other);
  // a different gjc in the pane, and the old one's number coming back, start over
  expect(await boundGjcTranscript("w1:p1", 201, offScreen)).toBeNull();
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBeNull();
  // gjc gone from the pane: nothing is answered, whatever the screen still shows
  expect(await boundGjcTranscript("w1:p1", 200, async () => file)).toBe(file);
  expect(await boundGjcTranscript("w1:p1", null, async () => file)).toBeNull();
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBeNull();
  expect(await boundGjcTranscript("w1:p1", 200, async () => file)).toBe(file);
  forgetTranscriptState();
  expect(await boundGjcTranscript("w1:p1", 200, offScreen)).toBeNull();
});

it("asks the Windows process table once for the polls of a few seconds", async () => {
  forgetTranscriptState();
  const rows = [{ pid: 100, parent: 4, path: null, commandLine: "powershell.exe" }];
  let asked = 0;
  const read = async () => { asked += 1; return rows; };
  expect(await recentProcessTable(read, 10_000)).toBe(rows);
  // two polls arriving together share one query
  await Promise.all([recentProcessTable(read, 12_000), recentProcessTable(read, 14_000)]);
  expect(asked).toBe(1);
  await recentProcessTable(read, 16_000);
  expect(asked).toBe(2);
  // a table that could not be read is not kept
  forgetTranscriptState();
  let failed = 0;
  const unreadable = async () => { failed += 1; return []; };
  await recentProcessTable(unreadable, 20_000);
  await recentProcessTable(unreadable, 20_001);
  expect(failed).toBe(2);
});

it("keeps every whole record of a candidate's tail window", () => {
  const root = tempDir("gjc-candidates-");
  try {
    mkdirSync(join(root, "project"));
    const path = join(root, "project", "session.jsonl");
    // every line is `line` bytes plus its newline: 1024 divides 64 KiB, so that window starts on a record
    for (const [line, aligned] of [[1000, false], [1023, true]] as const) {
      const record = (i: number) => {
        const text = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `answer ${String(i).padStart(3, "0")} ` }] } });
        return text.replace(" \"}]", ` ${"x".repeat(line - text.length)}"}]`);
      };
      const full = [JSON.stringify({ type: "session", cwd: "/work" }), ...Array.from({ length: 100 }, (_, i) => record(i))].join("\n") + "\n";
      writeFileSync(path, full);
      const start = full.length - 65536;
      expect(full[start - 1] === "\n").toBe(aligned);
      const [candidate] = gjcDisplayCandidates(root, "/work");
      // only a record the window cuts is dropped; the first whole one stays
      expect(candidate?.text).toBe(full.slice(aligned ? start : full.indexOf("\n", start) + 1));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("matches only substantial assistant text and rejects shared or short text", () => {
  const answer = "A unique assistant response with enough concrete details to identify this conversation across terminal line wrapping and punctuation changes.";
  const file = (path: string, role: string, text: string) => ({ path, text: JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) });
  expect(matchGjcTranscript(answer.replaceAll(" ", "\n"), [file("a", "assistant", answer)])).toBe("a");
  expect(matchGjcTranscript(answer, [file("a", "assistant", answer), file("b", "assistant", answer)])).toBeNull();
  expect(matchGjcTranscript(answer, [file("a", "user", answer)])).toBeNull();
  expect(matchGjcTranscript("Done", [file("a", "assistant", "Done")])).toBeNull();
});
