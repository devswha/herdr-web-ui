import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";

const fixture = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-goal-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

/** Claude Code 2.1.304's /rewind, recorded over a resumed apple/banana session (fixtures named by state and width) */
const rewind = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-rewind-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

describe("Claude Code's /rewind", () => {
  const CHOICES = ["Restore conversation", "Summarize from here", "Summarize up to here", "Never mind"];

  for (const width of [40, 120]) {
    test(`reads the confirm step's choices at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("confirm-apple", width));
      expect(prompt?.options.map((option) => option.label)).toEqual(CHOICES);
      expect(prompt?.body?.split("\n")[0]).toBe("apple");
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
      expect(answerKeys(prompt!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    });

    test(`reads the message list with the cursor on (current) at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("select-current", width));
      expect(prompt?.options.map((option) => option.label)).toEqual(["banana"]);
      // the cursor starts under the messages, on the session as it is now
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    });

    test(`reads the message list scrolled to banana at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", rewind("select-banana", width));
      expect(prompt?.options.map((option) => option.label)).toEqual(["apple", "banana"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
      expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["enter"] }]);
    });
  }

  test("reads the confirm step under a rule a tip takes the start of", () => {
    const prompt = parseInteractivePrompt("claude", rewind("confirm-apple-tip", 40));
    expect(prompt?.options.map((option) => option.label)).toEqual(CHOICES);
    expect(prompt?.body?.split("\n")[0]).toBe("apple");
  });

  test("joins a long message the narrow confirm step wraps", () => {
    const prompt = parseInteractivePrompt("claude", rewind("confirm-long", 40));
    expect(prompt?.body?.split("\n")[0]).toBe("please describe the history of the cherry orchard near the river in some detail");
    expect(prompt?.options.map((option) => option.label)).toEqual(CHOICES);
  });

  test("the age under the message stays out of the card's identity", () => {
    const shown = rewind("confirm-apple", 120);
    expect(parseInteractivePrompt("claude", shown.replace("(3h ago)", "(4h ago)"))?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a confirm step the recording does not show gets no card", () => {
    const shown = rewind("confirm-apple", 120);
    expect(parseInteractivePrompt("claude", shown.replace("2. Summarize from here", "2. Restore code"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("   Rewind\n", "   Rollback\n"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
  });

  test("a list cut by a later line gets no card", () => {
    expect(parseInteractivePrompt("claude", `${rewind("select-banana", 120)}\n❯ hello`)).toBeNull();
  });
});

describe("Claude Code's bare /goal", () => {
  for (const width of [40, 120]) {
    test(`reads the goal dialog with a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("active", width));
      expect(prompt?.title).toBe("Goal active");
      expect(prompt?.question).toBe("the file hello.txt exists in the project directory");
      expect(prompt?.body).toMatch(/^running \d+s · 0 tokens$/);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    });

    test(`reads the goal dialog without a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("none", width));
      expect(prompt?.title).toBe("Goal");
      expect(prompt?.question).toBe("No goal set");
      expect(prompt?.body).toBeNull();
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    });
  }

  test("a card for the same goal keeps its identity while the elapsed time ticks", () => {
    const shown = fixture("active", 120);
    const later = shown.replace(/running \d+s/, "running 4m 12s");
    expect(later).not.toBe(shown);
    expect(parseInteractivePrompt("claude", later)?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a different goal is a different card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replaceAll("hello.txt", "other.txt"))?.id).not.toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a running row that is not the recorded shape gets no card", () => {
    const shown = fixture("active", 120);
    for (const row of ["running a new unrecorded status", "running 25s", "running 25s · 0 tokens left", "running soon · 0 tokens"]) {
      expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, row)), row).toBeNull();
    }
    expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, "running 1h 2m 3s · 1,204 tokens"))?.title).toBe("Goal active");
  });

  test("a layout the dialog does not draw gets no card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replace("◎ Goal active", "◎ Goal achieved"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("Esc to dismiss", "Esc to dismiss\n\n   Clear goal"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
    expect(parseInteractivePrompt("claude", fixture("none", 120).replace("No goal set", "Goal paused"))).toBeNull();
  });
});
