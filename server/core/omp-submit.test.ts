import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmitText, ompInputText } from "./composer.ts";

// Captured from omp 18.12.3 in an isolated herdr session: /effort sent by agent.prompt while omp
// was still starting, left typed in its input box (the pane's folder renamed).
const STARTING = readFileSync(new URL("../fixtures/omp-input-18.12.3-starting.txt", import.meta.url), "utf8");
const header = `╭── π > ◒ Opus 5.5 👁 > 🗑 project > (sub) ▶─1%${"─".repeat(60)}╮`;
const box = (...rows: string[]): string => {
  const last = rows.pop() ?? "";
  return ["", header, ...rows.map((row) => `│  ${row.padEnd(100)}  │`), `╰─ ${last.padEnd(100)} ─╯`, ""].join("\n");
};
const EMPTY = box("");

describe("ompInputText", () => {
  it("reads what omp's input box holds, a row wrapped into its bottom border included", () => {
    expect(ompInputText(STARTING)).toBe("/effort");
    expect(ompInputText(EMPTY)).toBe("");
    expect(ompInputText(box("x".repeat(100), "xx end"))).toBe(`${"x".repeat(100)}\nxx end`);
  });

  it("reads no box under which anything else ends the screen", () => {
    expect(ompInputText(`${STARTING}\nlater output\n`)).toBeNull();
    expect(ompInputText("$ ls\nREADME.md\n")).toBeNull();
  });
});

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let agent: string;
let screen: string;
let calls: { method: string; params: Record<string, unknown>; shown?: string }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-omp-submit-"));
  agent = "omp";
  screen = EMPTY;
  calls = [];
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: Record<string, unknown> };
        calls.push({ method: request.method, params: request.params ?? {}, ...(request.method === "pane.read" ? { shown: screen } : {}) });
        const result = request.method === "pane.get"
          ? { pane: { pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "w:p1", cwd: root, focused: false, revision: 0, agent } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [] } }
          : request.method === "pane.read" ? { read: { text: screen } }
          : request.method === "agent.prompt" || request.method === "pane.send_keys" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0, ompSubmitCheckMs: 5 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const count = (method: string): number => calls.filter((call) => call.method === method).length;
const enters = (): number => calls.filter((call) => call.method === "pane.send_keys" && (call.params["keys"] as string[]).join() === "Enter").length;
async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("a message sent to omp", () => {
  it("presses Enter again while omp's box still holds the message, and stops once omp took it", async () => {
    screen = STARTING;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(calls.some((call) => call.method === "agent.prompt" && call.params["text"] === "/effort")).toBeTrue();
    await until("a second Enter", () => enters() >= 1);
    // omp is ready and takes the Enter: its box reads empty at the next look
    screen = EMPTY;
    await until("the empty box read", () => calls.some((call) => call.shown === EMPTY));
    const emptied = calls.findIndex((call) => call.shown === EMPTY);
    expect(calls.slice(emptied).some((call) => call.method === "pane.send_keys"), "no Enter into a box the message has left").toBeFalse();
    expect(calls.slice(0, emptied).every((call) => call.method !== "pane.send_keys" || (call.params["keys"] as string[]).join() === "Enter")).toBeTrue();
  });

  it("looks once and presses nothing when omp took the message at once", async () => {
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("the box read", () => count("pane.read") >= 1);
    expect(enters()).toBe(0);
  });

  it("presses nothing into a box that holds something else", async () => {
    screen = box("/effort and what the user typed since");
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("the box read", () => count("pane.read") >= 1);
    expect(enters()).toBe(0);
  });

  it("asks again whether the sender may still send before each Enter, and presses none once it may not", async () => {
    screen = STARTING;
    let permitted = true;
    let refused = 0;
    const authorize = () => { if (!permitted) { refused += 1; throw new Error("revoked"); } };
    await submitter()("w:p1", "/effort", "/effort", Date.now(), false, authorize);
    permitted = false;
    await until("the sender asked again", () => refused > 0);
    expect(enters()).toBe(0);
  });

  it("does not look at another agent's screen", async () => {
    agent = "codex";
    screen = STARTING;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("pane.read")).toBe(0);
    expect(enters()).toBe(0);
  });
});
