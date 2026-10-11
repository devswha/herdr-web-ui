import { describe, expect, it } from "bun:test";
import { codexSteeringPending, interruptCodexSteering, type CodexSteeringContext } from "./codex-steering.ts";

const hint = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const frame = (header = hint, composer = "› Ask Codex to do anything") => `› earlier input\n• Working (2s • esc to interrupt)\n• ${header}\n  ↳ send this now\n${composer}\n  gpt-6.1 default · /workspace\n`;
const working: CodexSteeringContext = { agent: "codex", working: true, screen: frame() };

describe("Codex's live steering buffer", () => {
  it("recognizes the native pending-steering panel beside an empty composer", () => {
    expect(codexSteeringPending(frame())).toBe(true);
    expect(codexSteeringPending(frame(hint, "›"))).toBe(true);
  });

  it("recognizes a narrow pane's wrapped native hint", () => {
    expect(codexSteeringPending(frame("Messages to be submitted after next tool\ncall (press esc to interrupt and send\nimmediately)"))).toBe(true);
  });

  for (const elapsed of ["1m 12s", "1h 2m 3s", "2m"]) it(`recognizes a working turn lasting ${elapsed}`, () => {
    expect(codexSteeringPending(frame().replace("2s • esc", `${elapsed} • esc`))).toBe(true);
  });

  for (const [name, screen] of [
    ["quoted hint", `› explain this\n${hint}\n• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["old panel above a newer turn", `${frame()}\n• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["native next-turn queue", frame("Queued follow-up inputs")],
    ["nonempty composer", frame(hint, "› unsent user draft")],
    ["missing pending message", frame().replace("  ↳ send this now\n", "")],
    ["no native working status", frame().replace("• Working (2s • esc to interrupt)\n", "")],
    ["another open UI after the composer", `${frame()}Select Model and Effort\nenter select · esc back\n`],
  ]) it(`does not authorize Escape from ${name}`, () => {
    expect(codexSteeringPending(screen!)).toBe(false);
  });
});

function fixture(contexts: CodexSteeringContext[] = [working]) {
  let now = 0; let reads = 0;
  const effects: string[] = [];
  const io = {
    read: async () => contexts[Math.min(reads++, contexts.length - 1)]!,
    escape: async () => { effects.push("Escape"); },
    restarting: () => { effects.push("restart gate"); },
    now: () => now,
    wait: async (ms: number) => { now += ms; },
  };
  return { io, effects, elapsed: () => now, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe("explicit Codex Send now", () => {
  it("arms the restart gate before one Escape on a freshly checked native panel", async () => {
    const f = fixture(); await interruptCodexSteering(true, working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
    expect(f.reads()).toBe(1);
  });

  for (const [name, explicit, context] of [
    ["ordinary Send racing with work", false, working],
    ["idle Codex", true, { ...working, working: false }],
    ["another working agent", true, { ...working, agent: "claude" }],
  ] as const) it(`never interrupts ${name}`, async () => {
    const f = fixture(); await interruptCodexSteering(explicit, context, f.io);
    expect(f.effects).toEqual([]); expect(f.reads()).toBe(0);
  });

  it("waits for the native panel instead of appending Escape blindly", async () => {
    const f = fixture([{ ...working, screen: "• Working (2s • esc to interrupt)\n› send this now\n" }, working]);
    await interruptCodexSteering(true, working, f.io);
    expect(f.reads()).toBe(2); expect(f.elapsed()).toBeGreaterThan(0);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
  });

  it("does not interrupt a turn that already finished after Enter", async () => {
    const f = fixture([{ ...working, working: false }]);
    await interruptCodexSteering(true, working, f.io); expect(f.effects).toEqual([]);
  });

  for (const cause of ["disconnected", "read_only", "agent_blocked", "pending_target_changed", "input_not_ready"]) it(`keeps additional input cancelled after ${cause}`, async () => {
    const f = fixture(); f.io.read = async () => { throw new Error(cause); };
    await expect(interruptCodexSteering(true, working, f.io)).rejects.toThrow(cause);
    expect(f.effects).toEqual([]);
  });

  it("does not claim success for working Codex without a recognized pending panel", async () => {
    const f = fixture([{ ...working, screen: frame("Queued follow-up inputs") }]);
    await expect(interruptCodexSteering(true, working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]); expect(f.elapsed()).toBeLessThanOrEqual(1500);
  });

  it("checks the deadline again after a slow screen read before sending Escape", async () => {
    const f = fixture(); f.io.read = async () => { f.advance(1501); return working; };
    await expect(interruptCodexSteering(true, working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });
});
