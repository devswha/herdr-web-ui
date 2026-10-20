import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneRewindResponse } from "../shared/protocol.ts";
import { socketAddress } from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { restoredOnScreen, walkClaudeRewind, type RewindIo } from "./rewind.ts";
import { configureClaudeRewinds, observeClaudeIdentity, rewindClaudeTranscriptAt } from "./conversation.ts";
import { chatOwnedInput, lastChatSubmitted } from "./prompt.ts";
import { writeFileSync } from "node:fs";

/** Claude Code 2.1.304's /rewind at 40 columns, recorded (server/fixtures) */
const screen = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}-40.txt`, import.meta.url), "utf8");

/**
 * The dialog as the recordings show it: the list's screen for each row the cursor is on, the
 * confirm step recorded for some of them, ↑/↓ moving the cursor, Enter on a row opening its confirm
 * step, "Never mind" (the fourth choice) going back to the same row, Esc closing the list. A key the
 * recordings do not show leaves the screen as it is.
 */
function recordedDialog(rows: string[], confirms: Record<number, string>) {
  let state: { at: "closed" } | { at: "list"; row: number } | { at: "confirm"; row: number; choice: number } = { at: "closed" };
  const sent: string[] = [];
  const read = (): string => state.at === "closed" ? screen("closed") : state.at === "list" ? screen(rows[state.row]!) : screen(confirms[state.row]!);
  const press = (key: string): void => {
    sent.push(key);
    if (state.at === "list") {
      if (key === "up") state = { at: "list", row: Math.max(0, state.row - 1) };
      else if (key === "esc") state = { at: "closed" };
      else if (key === "enter" && confirms[state.row] !== undefined) state = { at: "confirm", row: state.row, choice: 0 };
    } else if (state.at === "confirm") {
      if (key === "down") state = { ...state, choice: Math.min(3, state.choice + 1) };
      else if (key === "enter" && state.choice === 3) state = { at: "list", row: state.row };
    }
  };
  const io: RewindIo = {
    read: async () => read(),
    keys: async (keys) => { for (const key of keys) press(key); },
    command: async (text) => { sent.push(text); if (text === "/rewind" && state.at === "closed") state = { at: "list", row: rows.length - 1 }; },
  };
  return { io, sent, state: () => state };
}

const fruit = () => recordedDialog(["after-never-mind", "select-banana", "select-current"], { 0: "confirm-apple" });
const LONG = "please describe the history of the cherry orchard near the river in some detail";
const long = () => recordedDialog(["select-long-apple", "select-long", "select-long-banana", "select-long-current"], { 1: "confirm-long" });

describe("walking Claude Code's rewind list", () => {
  it("moves up to the message and opens its confirm step", async () => {
    const dialog = fruit();
    expect(await walkClaudeRewind(dialog.io, "apple", 0)).toBe("shown");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter"]);
    expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
  });

  it("finds a message the narrow list cuts short, by the confirm step's quote", async () => {
    const dialog = long();
    expect(await walkClaudeRewind(dialog.io, LONG, 0)).toBe("shown");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter"]);
  });

  it("goes back to the list when a cut row was another message, and closes the list when none is left", async () => {
    const dialog = long();
    expect(await walkClaudeRewind(dialog.io, "please describe the history of something else", 0)).toBe("not_found");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "enter", "down", "down", "down", "enter", "up", "esc"]);
    expect(dialog.state()).toEqual({ at: "closed" });
  });

  it("walks past newer messages with the same words", async () => {
    const dialog = fruit();
    expect(await walkClaudeRewind(dialog.io, "apple", 1)).toBe("not_found");
    expect(dialog.sent).toEqual(["/rewind", "up", "up", "esc"]);
  });

  it("sends nothing more once the dialog does not show what a key did", async () => {
    const dialog = fruit();
    const io: RewindIo = { ...dialog.io, command: async (text) => { dialog.sent.push(text); } };
    expect(await walkClaudeRewind(io, "apple", 0, 60)).toBe("changed");
    expect(dialog.sent).toEqual(["/rewind"]);
  });
});

/** A herdr stand-in for one pane: the recorded dialog answers its reads, keys and prompts. */
async function withHerdr(pane: { agent: string; status: string }, dialog: ReturnType<typeof recordedDialog>, run: (paneId: string, prompts: string[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-rewind-"));
  const socketPath = join(root, "herdr.sock");
  const previous = process.env.HERDR_SOCKET;
  const paneId = "rewind-pane";
  const prompts: string[] = [];
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input) as { id: string; method: string; params?: { keys?: string[]; text?: string } };
      void (async () => {
        let result: unknown = {};
        if (request.method === "pane.get") result = { pane: { pane_id: paneId, agent: pane.agent, agent_status: pane.status, cwd: root } };
        else if (request.method === "pane.read") result = { read: { text: await dialog.io.read() } };
        else if (request.method === "pane.send_keys") await dialog.io.keys(request.params?.keys ?? []);
        else if (request.method === "agent.prompt") { prompts.push(request.params?.text ?? ""); await dialog.io.command(request.params?.text ?? ""); }
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
  process.env.HERDR_SOCKET = socketPath;
  try {
    await run(paneId, prompts);
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

const rewind = async (body: unknown): Promise<[number, unknown]> => {
  const url = new URL("http://localhost/api/pane/rewind");
  const response = (await handlePaneRequest(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, "/api/pane/rewind", {}))!;
  return [response.status, await response.json()];
};

describe("the box a restore filled, before the next send empties it (core/composer.ts freeClaudeBox)", () => {
  it("is the chat's own only for the Claude process that restored it", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-rewind-owner-"));
    try {
      const records = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-fork.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
      const path = join(root, "session.jsonl");
      writeFileSync(path, `${records.slice(0, records.findIndex((line) => line.includes('"content":"cherry"'))).join("\n")}\n`);
      observeClaudeIdentity(path, 4242);
      expect(rewindClaudeTranscriptAt(path, "apple", 0, { pid: 4242, paneId: "owner-pane" })).toBe("apple");
      // the restored words are not the chat's last send: only the identity-bound owner offers them
      expect(lastChatSubmitted("owner-pane")).toBeNull();
      // another Claude process on the pane: the box holds nothing the chat may clear
      observeClaudeIdentity(path, 4343);
      expect(await chatOwnedInput("owner-pane")).toBeNull();
    } finally {
      configureClaudeRewinds(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Claude Code after Restore conversation", () => {
  const recorded = (name: string): string => readFileSync(new URL(`./fixtures/claude-rewind-2.1.304-${name}.txt`, import.meta.url), "utf8");
  for (const width of [40, 120]) {
    it(`sees the message back in Claude's input box at ${width} columns`, () => {
      expect(restoredOnScreen(recorded(`restored-${width}`), "apple")).toBe(true);
      expect(restoredOnScreen(recorded(`restored-${width}`), "banana")).toBe(false);
      // the first Esc only arms the clear ("Esc again to clear"); the second empties the box
      expect(restoredOnScreen(recorded(`restored-esc-${width}`), "apple")).toBe(true);
      expect(restoredOnScreen(recorded(`restored-cleared-${width}`), "apple")).toBe(false);
      expect(restoredOnScreen(recorded(`confirm-apple-${width}`), "apple")).toBe(false);
    });
  }
});

describe("POST /api/pane/rewind", () => {
  it("opens Claude Code's confirm step for the message", async () => {
    const dialog = fruit();
    await withHerdr({ agent: "claude", status: "idle" }, dialog, async (paneId, prompts) => {
      expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([200, { ok: true, outcome: "interaction-required" } satisfies PaneRewindResponse]);
      expect(prompts).toEqual(["/rewind"]);
      expect(dialog.state()).toEqual({ at: "confirm", row: 0, choice: 0 });
    });
  });

  it("refuses grok and agy, whose input box nothing here reads, over a draft or not", async () => {
    for (const agent of ["grok", "agy"]) {
      for (const box of ["", "half a thought"]) {
        const dialog = fruit();
        const io = { ...dialog.io, read: async () => `\n\n\n> ${box}\n` };
        await withHerdr({ agent, status: "done" }, { ...dialog, io }, async (paneId, prompts) => {
          expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([409, { error: expect.objectContaining({ code: "input_draft" }) }]);
          expect(prompts).toEqual([]);
          expect(dialog.sent).toEqual([]);
        });
      }
    }
  });

  it("refuses while the agent works, for another agent, and over a draft in Claude Code's box", async () => {
    await withHerdr({ agent: "claude", status: "working" }, fruit(), async (paneId, prompts) => {
      expect((await rewind({ pane_id: paneId, text: "apple" }))[0]).toBe(409);
      expect(prompts).toEqual([]);
    });
    await withHerdr({ agent: "codex", status: "idle" }, fruit(), async (paneId, prompts) => {
      expect((await rewind({ pane_id: paneId, text: "apple" }))[0]).toBe(400);
      expect(prompts).toEqual([]);
    });
    const drafted = fruit();
    const io = { ...drafted.io, read: async () => screen("closed").replace(/❯\s*$/m, "❯ half a thought") };
    await withHerdr({ agent: "claude", status: "idle" }, { ...drafted, io }, async (paneId, prompts) => {
      expect(await rewind({ pane_id: paneId, text: "apple" })).toEqual([409, { error: expect.objectContaining({ code: "input_draft" }) }]);
      expect(prompts).toEqual([]);
    });
  });

  it("refuses a body without the message", async () => {
    expect((await rewind({ pane_id: "p" }))[0]).toBe(400);
    expect((await rewind({ pane_id: "p", text: "apple", later: -1 }))[0]).toBe(400);
  });
});
