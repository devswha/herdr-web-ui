import { describe, expect, test } from "bun:test";
import { RELAY_STALL_CLOSE_CODE, RelayStallClock, upstreamCloseCode } from "./machine-relay.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";

/** Samples every 100 ms like the relay's timer, returning the first close code. */
function run(clock: RelayStallClock, buffered: (at: number) => number, from: number, until: number): number {
  for (let at = from; at <= until; at += 100) {
    const code = clock.sample(buffered(at), at);
    if (code) return code;
  }
  return 0;
}

describe("RelayStallClock", () => {
  test("a few KB queued below the high-water mark for 3 s does not close", () => {
    expect(run(new RelayStallClock(), () => 8 * 1024, 0, 3000)).toBe(0);
    expect(run(new RelayStallClock(), () => OUTPUT_HIGH_BYTES - 1, 0, 3000)).toBe(0);
  });

  test("a relay-own stall above the high-water mark closes with a reconnectable code", () => {
    const clock = new RelayStallClock();
    expect(clock.sample(OUTPUT_HIGH_BYTES, 0)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES + 1, OUTPUT_STALL_MS - 1)).toBe(0);
    const code = clock.sample(OUTPUT_HIGH_BYTES + 1, OUTPUT_STALL_MS);
    expect(code).toBe(RELAY_STALL_CLOSE_CODE);
    expect(code).not.toBe(OUTPUT_STALLED_CLOSE_CODE);
    expect([1012, 1013]).toContain(code);
  });

  test("the clock stays latched between the low and high marks and clears at the low mark", () => {
    const latched = new RelayStallClock();
    latched.sample(OUTPUT_HIGH_BYTES, 0);
    expect(run(latched, () => OUTPUT_LOW_BYTES + 1, 100, OUTPUT_STALL_MS)).toBe(RELAY_STALL_CLOSE_CODE);

    const drained = new RelayStallClock();
    drained.sample(OUTPUT_HIGH_BYTES, 0);
    drained.sample(OUTPUT_LOW_BYTES, 1000);
    expect(drained.sample(OUTPUT_HIGH_BYTES, 1500)).toBe(0);
    expect(drained.sample(OUTPUT_HIGH_BYTES, 1500 + OUTPUT_STALL_MS - 1)).toBe(0);
    expect(drained.sample(OUTPUT_HIGH_BYTES, 1500 + OUTPUT_STALL_MS)).toBe(RELAY_STALL_CLOSE_CODE);
  });

  test("buffering past the hard budget still closes at once as an overflow", () => {
    expect(new RelayStallClock().sample(OUTPUT_HARD_BYTES + 1, 0)).toBe(OUTPUT_STALLED_CLOSE_CODE);
  });
});

describe("upstreamCloseCode", () => {
  test("passes an upstream 4008 through unchanged and maps other ends to 1012", () => {
    expect(upstreamCloseCode(OUTPUT_STALLED_CLOSE_CODE)).toBe(OUTPUT_STALLED_CLOSE_CODE);
    expect(upstreamCloseCode(1006)).toBe(1012);
    expect(upstreamCloseCode(1000)).toBe(1012);
  });
});
