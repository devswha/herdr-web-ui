import { describe, expect, test } from "bun:test";
import { spaceHoldDown, spaceHoldUp, type SpaceHold } from "./spaceHold.ts";

function run(events: Array<"down" | "repeat" | "up">): { sent: number; taps: number; state: SpaceHold } {
  let state: SpaceHold = "idle";
  let sent = 0;
  let taps = 0;
  for (const event of events) {
    if (event === "up") {
      const next = spaceHoldUp(state);
      state = next.state;
      if (next.tap) taps += 1;
    } else {
      const next = spaceHoldDown(state, event === "repeat");
      state = next.state;
      sent += next.send;
    }
  }
  return { sent, taps, state };
}

describe("spaceHold", () => {
  test("a tap sends nothing to the pane and types one space", () => {
    expect(run(["down", "up"])).toEqual({ sent: 0, taps: 1, state: "idle" });
  });

  test("a hold sends the first press and every repeat, as a terminal does", () => {
    expect(run(["down", "repeat", "repeat", "repeat", "up"])).toEqual({ sent: 4, taps: 0, state: "idle" });
  });

  test("a repeat with no press seen (focus came mid-hold) sends the held space too", () => {
    expect(run(["repeat", "repeat", "up"])).toEqual({ sent: 3, taps: 0, state: "idle" });
  });

  test("two taps in a row each type a space", () => {
    expect(run(["down", "up", "down", "up"])).toEqual({ sent: 0, taps: 2, state: "idle" });
  });
});
