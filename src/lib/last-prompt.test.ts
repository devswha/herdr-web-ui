import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { lastPromptIndex, promptIndexBefore, promptLine, promptOf } from "./last-prompt.ts";

const user = (...parts: ConversationTurn["parts"]): ConversationTurn => ({ role: "user", ts: null, parts });
const answer: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Answer" }] };

describe("recorded prompt navigation", () => {
  it("reads separate text parts and native images without requiring text", () => {
    const image = { kind: "image", media_type: "image/png", ref: "one" } as const;
    expect(promptOf(user({ kind: "text", text: "First" }, { kind: "text", text: "Second" }, image))).toEqual({ text: "First\n\nSecond", images: 1 });
    expect(promptOf(user(image))).toEqual({ text: "", images: 1 });
  });

  it("excludes assistant turns, empty users and runtime-created user turns", () => {
    for (const turn of [answer, user(), user({ kind: "text", text: " \n " }),
      user({ kind: "compact", text: "Summary" }, { kind: "text", text: "Not a prompt" }),
      user({ kind: "notice", text: "Notice" }, { kind: "text", text: "Not a prompt" }),
      user({ kind: "task_result", tasks: [] }, { kind: "text", text: "Not a prompt" })]) {
      expect(promptOf(turn)).toBeNull();
    }
  });

  it("finds an answer's own preceding prompt, not the latest or an identical older prompt", () => {
    const repeated = user({ kind: "text", text: "Again" });
    const turns = [repeated, answer, user({ kind: "notice", text: "Wake" }), repeated, answer, answer];
    expect(lastPromptIndex(turns)).toBe(3);
    expect(promptIndexBefore(turns, 1)).toBe(0);
    expect(promptIndexBefore(turns, 4)).toBe(3);
    expect(promptIndexBefore(turns, 5)).toBe(3);
  });

  it("recomputes indices after older pages join and has no target in a replaced history", () => {
    const first = user({ kind: "text", text: "First" });
    const latest = [user({ kind: "text", text: "Second" }), answer];
    expect(promptIndexBefore(latest, 1)).toBe(0);
    expect(promptIndexBefore([first, answer, ...latest], 3)).toBe(2);
    expect(lastPromptIndex([])).toBe(-1);
    expect(promptIndexBefore([answer], 0)).toBe(-1);
    expect(lastPromptIndex([answer])).toBe(-1);
  });

  it("folds whitespace for the line and names image-only prompts", () => {
    expect(promptLine({ text: "First\n\n  Second", images: 1 }, String)).toBe("First Second");
    expect(promptLine({ text: "", images: 2 }, String)).toBe("2");
  });
});
