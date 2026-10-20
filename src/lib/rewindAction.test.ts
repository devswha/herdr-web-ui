import { describe, expect, it } from "bun:test";
import { rewindAction } from "./rewindAction.ts";

describe("rewindAction", () => {
  it("walks Claude Code's rewind from a card, and only opens the terminal for grok and agy", () => {
    expect(rewindAction("claude")).toBe("card");
    expect(rewindAction("grok")).toBe("terminal");
    expect(rewindAction("agy")).toBe("terminal");
    for (const agent of ["codex", "omp", "opencode", null]) expect(rewindAction(agent)).toBeNull();
  });
});
