import { describe, expect, it } from "bun:test";

import { hermesInterruptible, stopKey } from "./hermesStop.ts";

// The bottom rows of real Hermes 0.21.5 screens (herdr pane read), classic CLI and TUI.
const CLASSIC_BUSY = [
  "n who controlled it, who could afford it, how it was prepared, and what people believed it could do.",
  " ☤ gpt-6-luna │ 0/272K │ [░░░░░░░░░░] 0% │ 3m │ ⏱ 8s                                     ─ Write a very long, detail...",
  "────────────────────────────────────────────────────────────────────────",
  "☤ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel",
  "────────────────────────────────────────────────────────────────────────",
];
const CLASSIC_IDLE = [
  "⚡ Interrupted during API call.",
  " ☤ gpt-6-luna │ 0/272K │ [░░░░░░░░░░] 0% │ 3m │ ⏲ 27s │ ✓ 0s                                           ─ History of tea",
  "────────────────────────────────────────────────────────────────────────",
  "❯ What changed in this repo recently?",
  "────────────────────────────────────────────────────────────────────────",
];
const TUI_BUSY = [
  " ❯ Write a very long essay (4000 words) about the history of coffee. No tools.                                     ┃",
  "    Coffee is at once a plant, a drink, a commodity, a ritual, and an idea.                                         ┃",
  " ─ ( ͡° ͜ʖ ͡°) brainstorming… · 3s │ gpt 6 luna │ 15s │ voice off │ 1 session                ─  Write essay on coffee history",
  " ❯ Ctrl+C to interrupt…",
];
const TUI_IDLE = [
  "    [interrupted]                                                                                                   ┃",
  " ─ ready │ gpt 6 luna │ 17s │ ✓ 1s │ voice off │ 1 session                                    ─  Write essay on coffee history",
  " ❯",
];

describe("hermesInterruptible", () => {
  it("reads a running turn from the input row of the classic CLI and the TUI", () => {
    expect(hermesInterruptible(CLASSIC_BUSY)).toBe(true);
    expect(hermesInterruptible(TUI_BUSY)).toBe(true);
  });

  it("says no for an idle Hermes, where Ctrl+C would exit it", () => {
    expect(hermesInterruptible(CLASSIC_IDLE)).toBe(false);
    expect(hermesInterruptible(TUI_IDLE)).toBe(false);
    expect(hermesInterruptible([])).toBe(false);
  });

  it("never counts the hint quoted in the transcript above an idle input row", () => {
    expect(hermesInterruptible(["❯ Ctrl+C to interrupt…", "assistant: done", "❯ Try \"fix the lint errors\""])).toBe(false);
    expect(hermesInterruptible(["☤ ❯ msg=interrupt · /queue · Ctrl+C cancel", "────", "❯ "])).toBe(false);
  });

  it("says no when a draft typed into a busy Hermes hides its hint", () => {
    expect(hermesInterruptible([...CLASSIC_BUSY.slice(0, 3), "☤ ❯ half a thought", CLASSIC_BUSY[4]!])).toBe(false);
  });
});

describe("stopKey", () => {
  const rows = () => CLASSIC_BUSY;

  it("keeps Escape for every other agent, without reading the screen", () => {
    expect(stopKey("claude", () => { throw new Error("read"); }, false)).toBe("\u001b");
    expect(stopKey(null, () => [], true)).toBe("\u001b");
  });

  it("sends Hermes one Ctrl+C per turn, and only while the turn shows", () => {
    expect(stopKey("hermes", rows, false)).toBe("\u0003");
    expect(stopKey("hermes", rows, true)).toBeNull();
    expect(stopKey("hermes", () => CLASSIC_IDLE, false)).toBeNull();
  });
});
