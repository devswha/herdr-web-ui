import { describe, expect, it } from "bun:test";

import { firstMessageFault, launchArgsFault, MODEL_NAME } from "./launch-rules.ts";

describe("an agent's launch arguments", () => {
  it("refuses a control character in any argument, a tab and a line break included", () => {
    expect(launchArgsFault("codex", ["--", "a\tb"])).toContain("control characters");
    expect(launchArgsFault("codex", ["--", "a\nb"])).toContain("control characters");
    expect(launchArgsFault("omp", ["--flag\u001b[2J"])).toContain("control characters");
  });
  it("takes Codex's one prompt after -- by a first message's rules", () => {
    expect(launchArgsFault("codex", ["--", "$review-pr the branch"])).toBeNull();
    expect(launchArgsFault("codex", ["--", "   "])).toContain("one prompt");
    expect(launchArgsFault("codex", ["--", "x".repeat(20_001)])).toContain("one prompt");
    expect(launchArgsFault("codex", ["--", "a", "b"])).toContain("one prompt");
  });
  it("takes only a one-word model and the effort levels each agent names", () => {
    expect(launchArgsFault("claude", ["--permission-mode", "plan", "--model", "opus[1m]", "--effort", "ultracode"])).toBeNull();
    expect(launchArgsFault("claude", ["--model", "--dangerously-skip-permissions"])).toContain("--model");
    expect(launchArgsFault("claude", ["--model"])).toContain("--model");
    expect(launchArgsFault("claude", ["--effort", "ultra"])).toContain("--effort");
    expect(launchArgsFault("codex", ["-c", "model_reasoning_effort=ultra", "-m", "gpt-6.1"])).toBeNull();
    expect(launchArgsFault("codex", ["-c", "model_reasoning_effort=ultracode"])).toContain("model_reasoning_effort");
    // other agents' arguments are theirs: only control characters are refused there
    expect(launchArgsFault("omp", ["--model", "two words"])).toBeNull();
  });
});

describe("a model name", () => {
  it("is one word, with an optional bracketed variant such as Claude Code's [1m]", () => {
    for (const name of ["opus", "claude-opus-4-5", "opus[1m]", "sonnet[1m]", "gpt-6.1", "openrouter/qwen:free"]) expect(MODEL_NAME.test(name), name).toBeTrue();
    for (const name of ["--model", "two words", "opus[1m", "opus[]", "[1m]"]) expect(MODEL_NAME.test(name), name).toBeFalse();
  });
});

describe("a first message", () => {
  it("keeps tabs and line breaks, which the queued path types as text, and refuses other control characters", () => {
    expect(firstMessageFault("line one\n\tline two", true)).toBeNull();
    expect(firstMessageFault("run \u001b[2J this", true)).toContain("control characters");
    expect(firstMessageFault("hi", null)).toContain("needs an agent");
  });
});
