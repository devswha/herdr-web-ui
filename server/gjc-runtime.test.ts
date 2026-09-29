import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gjcBreadcrumbPath, gjcDisplayCandidates, matchGjcTranscript, parseGjcPs } from "./gjc-runtime.ts";

it("reads macOS terminal/process identity without /proc", () => {
  expect(parseGjcPs("ttys003 Mon Sep 28 10:00:00 2026\n")?.id).toBe("ttys003");
  expect(parseGjcPs("?? Mon Sep 28 10:00:00 2026")).toBeNull();
  expect(parseGjcPs("ttys003 invalid")).toBeNull();
});

it("validates breadcrumbs against process age, canonical cwd and the native session store", () => {
  const home = mkdtempSync(join(tmpdir(), "gjc-breadcrumb-"));
  try {
    const store = join(home, ".gjc/agent/sessions");
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

it("keeps every whole record of a candidate's tail window", () => {
  const root = mkdtempSync(join(tmpdir(), "gjc-candidates-"));
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
