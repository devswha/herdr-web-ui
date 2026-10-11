import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsGrokReport, statuslineIdentity, withGrokReportLock } from "./grok-statusline.ts";
import type { GrokBinding } from "../server/grok-store.ts";

const binding: GrokBinding = { version: 1, socket: "/tmp/fiction.sock", pane: "w1:p1", pid: 123, started: "fiction:1", home: "/tmp/fiction", session: "00000000-0000-4000-8000-000000000001", transcript: "/tmp/fiction/sessions/group/00000000-0000-4000-8000-000000000001/updates.jsonl", observed_ns: "10000000000" };
test("reporter locking skips a competing connection and releases after failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-lock-unit-"));
  const file = join(root, "binding.lock");
  let competing = false, later = false;
  try {
    await expect(withGrokReportLock(file, async () => {
      await withGrokReportLock(file, async () => { competing = true; });
      throw new Error("fictional callback failure");
    })).rejects.toThrow("fictional callback failure");
    await withGrokReportLock(file, async () => { later = true; });
    expect(competing).toBe(false);
    expect(later).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("the reporter coalesces bursts, orders callbacks and refreshes an idle heartbeat", () => {
  expect(needsGrokReport(binding, { ...binding, observed_ns: "11000000000" })).toBe(false);
  expect(needsGrokReport(binding, { ...binding, observed_ns: "15000000000" })).toBe(true);
  expect(needsGrokReport(binding, { ...binding, session: "different", observed_ns: "9000000000" })).toBe(false);
  expect(needsGrokReport(binding, { ...binding, session: "different", observed_ns: "11000000000" })).toBe(true);
  expect(needsGrokReport(binding, { ...binding, started: "fiction:2", observed_ns: "11000000000" })).toBe(true);
  expect(needsGrokReport(binding, { ...binding, started: "fiction:2", observed_ns: "9000000000" })).toBe(false);
});
test("statusline identity requires the native UUID and path", () => {
  expect(statuslineIdentity({ session_id: binding.session, transcript_path: binding.transcript })).toEqual({ session: binding.session, transcript: binding.transcript });
  expect(statuslineIdentity({ session_id: "../escape", transcript_path: binding.transcript })).toBeNull();
});
for (const oversized of [false, true]) test(`outside Herdr, the wrapper preserves stdin, output and exit (oversized=${oversized})`, async () => {
  const root = mkdtempSync(join(tmpdir(), "grok-statusline-unit-"));
  try {
    const input = JSON.stringify({ session_id: binding.session, transcript_path: binding.transcript, cwd: "fiction 🌍" + (oversized ? "x".repeat(300_000) : "") }) + "\n";
    const child = Bun.spawn([process.execPath, new URL("./grok-statusline.ts", import.meta.url).pathname, "--", process.execPath, "-e", "process.stdout.write(await Bun.stdin.text()); process.exitCode=7"], { cwd: root, env: { PATH: process.env.PATH, HOME: root }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(input); child.stdin.end();
    expect(await new Response(child.stdout).text()).toBe(input);
    expect(await child.exited).toBe(7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
