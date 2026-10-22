import { describe, expect, test } from "bun:test";
import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import { CLAUDE_AUTO_RETURN, autoReturnArmed, commandScreenClosed, paneLensFlags, peekFor, returnBlocked, sentOutcome, type TerminalPeek } from "./terminalPeek.ts";

const peek: TerminalPeek = { slot: "a", machineId: "local", paneId: "w1:p1", command: "/usage", text: "/usage", knownOutcomeIds: ["o1"], auto: true };
const outcome = (id: string, text: string, created: string): CommandOutcome => ({
  id, pane_id: "w1:p1", text, state: "terminal-required", evidence: [], created_at: created, updated_at: created,
});
const notice = (ts: string | null, source = "local-command"): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "notice", text: "Settings dialog dismissed", source }] });
const SENT = "2026-10-22T01:00:00.000Z";

describe("paneLensFlags", () => {
  test("the chat lens covers the grid", () => {
    expect(paneLensFlags("chat", null)).toEqual({ chatMounted: true, gridCovered: true });
  });

  test("a peek keeps the chat mounted and uncovers the grid", () => {
    expect(paneLensFlags("chat", peek)).toEqual({ chatMounted: true, gridCovered: false });
  });

  test("the terminal lens has no chat to keep", () => {
    expect(paneLensFlags("terminal", null)).toEqual({ chatMounted: false, gridCovered: false });
    expect(paneLensFlags("terminal", peek)).toEqual({ chatMounted: false, gridCovered: false });
  });
});

describe("peekFor", () => {
  test("is the peek of its own half, PC and pane", () => {
    expect(peekFor(peek, "a", "local", "w1:p1")).toBe(peek);
  });

  test("no other half, PC or pane shows it", () => {
    expect(peekFor(peek, "b", "local", "w1:p1")).toBeNull();
    expect(peekFor(peek, "a", "remote", "w1:p1")).toBeNull();
    expect(peekFor(peek, "a", "local", "w1:p2")).toBeNull();
    expect(peekFor(peek, "a", "local", null)).toBeNull();
    expect(peekFor(null, "a", "local", "w1:p1")).toBeNull();
  });
});

describe("autoReturnArmed", () => {
  test("Claude Code comes back by itself after a recorded command, sent bare", () => {
    for (const command of CLAUDE_AUTO_RETURN) expect(autoReturnArmed("claude", `/${command}`, command)).toBe(true);
    expect(autoReturnArmed("claude", "/Config ", "Config")).toBe(true);
  });

  test("every other agent waits for the reader", () => {
    for (const agent of ["codex", "pi", "omp", "hermes", "opencode", null]) expect(autoReturnArmed(agent, "/status", "status")).toBe(false);
  });

  test("a command whose close records nothing the chat reads, or records at open, stays manual", () => {
    for (const command of ["diff", "export", "plugin", "mobile", "autocompact", "add-dir", "mcp", "scroll-speed", "sandbox", "tasks", "memory", "btw", "doctor"]) {
      expect(autoReturnArmed("claude", `/${command}`, command)).toBe(false);
    }
  });

  test("a custom or unknown command stays manual", () => {
    expect(autoReturnArmed("claude", "/deploy", "deploy")).toBe(false);
    expect(autoReturnArmed("claude", "/frobnicate", "frobnicate")).toBe(false);
  });

  test("only the bare form the recording covers", () => {
    expect(autoReturnArmed("claude", "/fast", "fast")).toBe(true);
    expect(autoReturnArmed("claude", "/fast on", "fast")).toBe(false);
    expect(autoReturnArmed("claude", "/resume 4f2a", "resume")).toBe(false);
  });
});

describe("sentOutcome", () => {
  test("is the outcome with the sent text the chat had not read", () => {
    const own = outcome("o2", "/usage", SENT);
    expect(sentOutcome(peek, [outcome("o1", "/status", SENT), own, outcome("o3", "/status", SENT)])).toBe(own);
  });

  test("passes over an identical send just before it that no read had listed yet", () => {
    // /usage sent, closed (its notice written), and sent again before the next prompt read: both
    // outcomes are new to this peek, and the earlier one's notice must not end it
    const earlier = outcome("o2", "/usage", "2026-10-22T00:59:58.000Z");
    const own = outcome("o3", "/usage", SENT);
    expect(sentOutcome(peek, [earlier, own])).toBe(own);
    expect(commandScreenClosed(peek, "claude", sentOutcome(peek, [earlier, own])!.created_at, [notice("2026-10-22T00:59:59.000Z")])).toBe(false);
  });

  test("passes over an older identical send", () => {
    const older = outcome("o1", "/usage", "2026-10-22T00:50:00.000Z");
    const own = outcome("o2", "/usage ", SENT);
    expect(sentOutcome(peek, [older, own])).toBe(own);
  });

  test("is null while the send's outcome is not listed yet", () => {
    expect(sentOutcome(peek, [outcome("o1", "/usage", SENT)])).toBeNull();
    expect(sentOutcome(peek, [])).toBeNull();
  });

  test("a peek opened by hand, or before the chat read any outcome, has none", () => {
    expect(sentOutcome({ ...peek, text: null }, [outcome("o2", "/usage", SENT)])).toBeNull();
    expect(sentOutcome({ ...peek, knownOutcomeIds: null }, [outcome("o2", "/usage", SENT)])).toBeNull();
  });
});

describe("commandScreenClosed", () => {
  test("a local-command notice written after the send closes it", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(true);
  });

  test("a notice from before the send, or at the same moment, does not", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T00:59:00.000Z")])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [notice(SENT)])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [notice(null)])).toBe(false);
  });

  test("only a local-command notice counts", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T01:00:04.000Z", "informational")])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [{ role: "assistant", ts: "2026-10-22T01:00:04.000Z", parts: [{ kind: "text", text: "Done." }] }])).toBe(false);
  });

  test("waits for the send's outcome to be listed", () => {
    expect(commandScreenClosed(peek, "claude", null, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
  });

  test("never for another agent or a peek left manual", () => {
    expect(commandScreenClosed(peek, "codex", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
    expect(commandScreenClosed({ ...peek, auto: false }, "claude", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
  });
});

describe("returnBlocked", () => {
  const none = { heldDraft: false, findOpen: false, composing: false };
  test("nothing in the way lets the chat come back", () => {
    expect(returnBlocked(none)).toBe(false);
  });

  test("held terminal input, the find bar or a composition keeps the terminal", () => {
    expect(returnBlocked({ ...none, heldDraft: true })).toBe(true);
    expect(returnBlocked({ ...none, findOpen: true })).toBe(true);
    expect(returnBlocked({ ...none, composing: true })).toBe(true);
  });
});
