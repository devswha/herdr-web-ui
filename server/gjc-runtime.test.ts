import { expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { forgetTranscriptState } from "./conversation.ts";
import { boundGjcTranscript, gjcSessionTitle, gjcStatusTitle, gjcBreadcrumbPath, gjcDisplayCandidates, gjcPidUnderShell, gjcSessionFile, isGjcProcess, matchGjcTranscript, parseGjcPs, recentProcessTable, storeRelative } from "./gjc-runtime.ts";

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
  expect(await gjcPidUnderShell(100, "win32", table)).toEqual({ pid: 200, started: null });
  // another pane's shell on the same PC does not run it
  expect(await gjcPidUnderShell(101, "win32", table)).toBeNull();
  expect(await gjcPidUnderShell(undefined, "win32", table)).toBeNull();
  // the process's start comes with it: a number alone is handed to the next process
  expect(await gjcPidUnderShell(100, "win32", async () => rows.map((row) => row.pid === 200 ? { ...row, started: 7 } : row))).toEqual({ pid: 200, started: 7 });
  // a table that could not be read says nothing about gjc
  expect(await gjcPidUnderShell(100, "win32", async () => [])).toBeUndefined();
  // elsewhere herdr's foreground processes are the answer and the table is never asked
  let asked = false;
  expect(await gjcPidUnderShell(100, "linux", async () => { asked = true; return rows; })).toBeNull();
  expect(asked).toBe(false);
});

it("reads the session title from gjc's status line", () => {
  // as gjc 0.16.4 draws it on a Windows PC: the status line sits right over the message box
  const BOX = "\n╭──────╮\n│ > Type your message... │\n╰──────╯";
  const status = (middle: string, dir = "~\\herdr-qa") => ` user\n ok\n ⬢ sonnet-5 · ◒ med · 1.8% / 📁 ${dir} ──────── ${middle} / v0.16.4${BOX}`;
  expect(gjcStatusTitle(status("Simple Ok Reply / ⤴ 0.3/s / $0.04 (sub)"))).toBe("Simple Ok Reply");
  // right after /new the session has no title yet
  expect(gjcStatusTitle(status("(sub)"))).toBeNull();
  // a title holds what it holds: a slash, a leading parenthesis, a word like a version
  expect(gjcStatusTitle(status("Plan / Fix / ⤴ 1.0/s / $0.10 (sub)"))).toBe("Plan / Fix");
  expect(gjcStatusTitle(status("(WIP) Fix / $0.04 (sub)"))).toBe("(WIP) Fix");
  expect(gjcStatusTitle(status("v2 Migration / (sub)"))).toBe("v2 Migration");
  expect(gjcStatusTitle(status("Simple Ok Reply / (sub)", "~\\a ──── b"))).toBe("Simple Ok Reply");
  // a title cut short by a narrow pane says nothing
  expect(gjcStatusTitle(status("Herdr GJC Binding Che… / ⤴ 13.6/s / $0.04 (sub)"))).toBeUndefined();
  // no status line over the box: a menu covers it, or no gjc
  expect(gjcStatusTitle(" Resume Session\n> \n❯ Simple Ok Reply")).toBeUndefined();
  // the same words printed in an answer are text, with the real line under them or without
  const printed = " gajae\n ⬢ x / 📁 archive ──── Other Session / v0.16.4\n more text";
  expect(gjcStatusTitle(printed)).toBeUndefined();
  expect(gjcStatusTitle(printed + "\n" + status("Real One / (sub)"))).toBe("Real One");
});

it("keeps a Windows pane on the session its screen once showed, while the same gjc runs there", async () => {
  forgetTranscriptState();
  const file = "C:\\s\\one.jsonl", other = "C:\\s\\two.jsonl";
  const gjc = { pid: 200, started: 1000 };
  const shows = (path: string | null) => async () => ({ path, title: undefined, titled: null, titledCount: 0 });
  const bind = (pane: string, process: typeof gjc | null | undefined, path: string | null) => boundGjcTranscript(pane, process, shows(path), () => null);
  // a running gjc alone names no session: the first answer needs the screen
  expect(await bind("w1:p1", gjc, null)).toBeNull();
  expect(await bind("w1:p1", gjc, file)).toBe(file);
  // a long answer pushed every answer's tail off the screen
  expect(await bind("w1:p1", gjc, null)).toBe(file);
  expect(await bind("w1:p2", gjc, null)).toBeNull();
  // the same process shows another session (/resume): the screen wins
  expect(await bind("w1:p1", gjc, other)).toBe(other);
  expect(await bind("w1:p1", gjc, null)).toBe(other);
  // a different gjc in the pane, and the old one's number coming back, start over
  expect(await bind("w1:p1", { pid: 201, started: 1100 }, null)).toBeNull();
  expect(await bind("w1:p1", gjc, null)).toBeNull();
  // gjc gone from the pane: nothing is answered, whatever the screen still shows
  expect(await bind("w1:p1", gjc, file)).toBe(file);
  expect(await bind("w1:p1", null, file)).toBeNull();
  expect(await bind("w1:p1", gjc, null)).toBeNull();
  forgetTranscriptState();
});

it("follows gjc's own session title across /new and /resume on a Windows pane", async () => {
  forgetTranscriptState();
  const first = "C:\\s\\first.jsonl", fresh = "C:\\s\\fresh.jsonl", twin = "C:\\s\\twin.jsonl", untitled = "C:\\s\\untitled.jsonl";
  const titles: Record<string, string | null> = { [first]: "Binding Check", [fresh]: "Simple Ok Reply", [twin]: "Simple Ok Reply", [untitled]: null };
  const titleOf = (path: string) => titles[path] ?? null;
  type Process = { pid: number; started: number | null };
  const gjc: Process = { pid: 200, started: 1000 };
  // the screen as gjcTranscriptForPane reads it: how many files carry the title, and the one that does
  const bind = (anchor: string | null, title: string | null | undefined, among: string[] = [first, fresh], process: Process | undefined = gjc) => {
    const carrying = typeof title === "string" ? among.filter((path) => titles[path] === title) : [];
    return boundGjcTranscript("w1:p1", process, async () => ({ path: anchor, title, titled: carrying.length === 1 ? carrying[0]! : null, titledCount: carrying.length }), titleOf);
  };
  expect(await bind(first, "Binding Check")).toBe(first);
  // /new: the status line shows no title, so the session running is not the titled one. The chat
  // shows none until it can tell (measured on a real PC: it stayed on the old conversation), also
  // while the old session's answer is still on screen
  expect(await bind(null, null)).toBeNull();
  expect(await bind(first, null)).toBeNull();
  // a session with no title of its own yet is kept under a status line without one
  expect(await bind(untitled, null, [first, fresh, untitled])).toBe(untitled);
  expect(await bind(null, null, [first, fresh, untitled])).toBe(untitled);
  // a one-word answer: gjc titles the new session, and one file carries that title (measured on a
  // real PC: the chat stayed on the old conversation here before)
  expect(await bind(null, "Simple Ok Reply")).toBe(fresh);
  // an answer of the old session pasted into the new one matches the old file, under the new title
  expect(await bind(first, "Simple Ok Reply")).toBe(fresh);
  // so does a pasted answer of a session that has no title of its own
  expect(await bind(untitled, "Simple Ok Reply", [first, fresh, untitled])).toBe(fresh);
  // /resume back to the first session with none of its answers on screen, and to the one already shown
  expect(await bind(null, "Binding Check")).toBe(first);
  expect(await bind(null, "Binding Check")).toBe(first);
  // two sessions share a title: resumed into one of them with no answer to tell, the chat shows
  // none, also when the pane was bound to the other one of the two
  expect(await bind(null, "Simple Ok Reply", [first, fresh, twin])).toBeNull();
  expect(await bind(fresh, "Simple Ok Reply", [first, fresh, twin])).toBe(fresh);
  expect(await bind(null, "Simple Ok Reply", [first, fresh, twin])).toBeNull();
  // an answer of one of the two tells them apart
  expect(await bind(twin, "Simple Ok Reply", [first, fresh, twin])).toBe(twin);
  // a status line too narrow for the title, or covered by a menu, changes nothing
  expect(await bind(first, "Binding Check")).toBe(first);
  expect(await bind(null, undefined)).toBe(first);
  // a title no file carries yet (gjc has not written it): a session titled otherwise is let go
  expect(await bind(null, "Not Written Yet")).toBeNull();
  forgetTranscriptState();
});

it("tells a reused process number by the start time, once it is known", async () => {
  forgetTranscriptState();
  const file = "C:\\s\\one.jsonl";
  type Process = { pid: number; started: number | null };
  const bind = (process: Process | undefined, path: string | null) => boundGjcTranscript("w1:p1", process, async () => ({ path, title: undefined, titled: null, titledCount: 0 }), () => null);
  // bound while the start time could not be read, learned later, then another process takes the number
  expect(await bind({ pid: 200, started: null }, file)).toBe(file);
  expect(await bind({ pid: 200, started: 1000 }, null)).toBe(file);
  expect(await bind({ pid: 200, started: 2000 }, null)).toBeNull();
  // a read without the start time does not erase the one known, with an answer on screen or none
  expect(await bind({ pid: 200, started: 1000 }, file)).toBe(file);
  expect(await bind({ pid: 200, started: null }, file)).toBe(file);
  expect(await bind({ pid: 200, started: null }, null)).toBe(file);
  expect(await bind({ pid: 200, started: 2000 }, null)).toBeNull();
  // a process table that could not be read changes nothing
  expect(await bind({ pid: 200, started: 1000 }, file)).toBe(file);
  expect(await bind(undefined, null)).toBe(file);
  forgetTranscriptState();
});

it("reads a session file's title from its header and gjc's later patches, a bounded part at a time", () => {
  forgetTranscriptState();
  const dir = mkdtempSync(join(tmpdir(), "herdr-gjc-title-"));
  try {
    const path = join(dir, "s.jsonl");
    const header = (title?: string) => JSON.stringify({ type: "session", id: "a", cwd: "C:\\x", ...(title ? { title } : {}) }) + "\n";
    const patch = (title: string) => JSON.stringify({ type: "header_patch", patch: { title, titleSource: "auto" } }) + "\n";
    writeFileSync(path, header());
    expect(gjcSessionTitle(path)).toBeNull();
    appendFileSync(path, patch("Binding Check"));
    expect(gjcSessionTitle(path)).toBe("Binding Check");
    // a "title" inside a message is not gjc's
    appendFileSync(path, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: '"title": no' }] } }) + "\n");
    expect(gjcSessionTitle(path)).toBe("Binding Check");
    // another file of the same size put in its place is read anew
    const replaced = header("Old Name");
    writeFileSync(path, replaced);
    expect(gjcSessionTitle(path)).toBe("Old Name");
    writeFileSync(path, replaced.replace("Old Name", "New Name"));
    expect(gjcSessionTitle(path)).toBe("New Name");
    // a long history is read within the budget: unknown until its end is reached, over several looks
    const long = join(dir, "long.jsonl");
    writeFileSync(long, header() + (JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] } }) + "\n").repeat(3000) + patch("Late Title"));
    expect(gjcSessionTitle(long, { bytes: 1024 * 1024 })).toBeUndefined();
    expect(gjcSessionTitle(long, { bytes: 1024 * 1024 })).toBeUndefined();
    expect(gjcSessionTitle(long, { bytes: 4 * 1024 * 1024 })).toBe("Late Title");
    // a record longer than a chunk (a picture) is passed over
    const picture = join(dir, "picture.jsonl");
    writeFileSync(picture, header() + JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(700 * 1024) }] } }) + "\n" + patch("After Picture"));
    expect(gjcSessionTitle(picture)).toBe("After Picture");
  } finally { rmSync(dir, { recursive: true, force: true }); forgetTranscriptState(); }
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
