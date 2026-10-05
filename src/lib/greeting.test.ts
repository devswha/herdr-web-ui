import { describe, expect, test } from "bun:test";
import { chatIsBlank, composerLift, greetingFolder, showsGreeting, type BlankChat, type GreetingState } from "./greeting.ts";

const blank: BlankChat = { loaded: true, failed: false, transcript: true, turns: 0, abandoned: 0, prompt: false, agent: "claude" };
const shown: GreetingState = { blankAtSent: 0, sent: 0, agentStatus: "idle", queued: 0, folder: "infra" };

describe("chatIsBlank", () => {
  test("a loaded transcript with no turns is blank", () => {
    expect(chatIsBlank(blank)).toBe(true);
  });

  test("a loading conversation is not", () => {
    expect(chatIsBlank({ ...blank, loaded: false })).toBe(false);
  });

  test("a read that failed is not", () => {
    expect(chatIsBlank({ ...blank, failed: true })).toBe(false);
  });

  test("an agent whose transcript could not be read (the scrollback stands in) is not", () => {
    expect(chatIsBlank({ ...blank, transcript: false })).toBe(false);
  });

  test("a pane with no recognized agent is not", () => {
    expect(chatIsBlank({ ...blank, agent: null })).toBe(false);
  });

  test("turns, turns left on another branch, or a waiting prompt are something to read", () => {
    expect(chatIsBlank({ ...blank, turns: 1 })).toBe(false);
    expect(chatIsBlank({ ...blank, abandoned: 3 })).toBe(false);
    expect(chatIsBlank({ ...blank, prompt: true })).toBe(false);
  });
});

describe("showsGreeting", () => {
  test("a blank chat of a resting agent is greeted", () => {
    expect(showsGreeting(shown)).toBe(true);
    expect(showsGreeting({ ...shown, agentStatus: "done" })).toBe(true);
    expect(showsGreeting({ ...shown, agentStatus: undefined })).toBe(true);
  });

  test("a chat that is not blank is not", () => {
    expect(showsGreeting({ ...shown, blankAtSent: null })).toBe(false);
  });

  test("the first message sent takes the greeting away before the transcript holds it", () => {
    expect(showsGreeting({ ...shown, sent: 1 })).toBe(false);
  });

  test("a chat found blank again after messages (a cleared conversation) is greeted again", () => {
    expect(showsGreeting({ ...shown, blankAtSent: 4, sent: 4 })).toBe(true);
  });

  test("an agent at work or asking is not asked what it should do", () => {
    expect(showsGreeting({ ...shown, agentStatus: "working" })).toBe(false);
    expect(showsGreeting({ ...shown, agentStatus: "blocked" })).toBe(false);
  });

  test("held messages keep their place over the composer", () => {
    expect(showsGreeting({ ...shown, queued: 1 })).toBe(false);
  });

  test("no folder, no greeting", () => {
    expect(showsGreeting({ ...shown, folder: "" })).toBe(false);
  });
});

describe("greetingFolder", () => {
  test("the last segment of a path", () => {
    expect(greetingFolder("/tmp/herdr-demo/infra")).toBe("infra");
    expect(greetingFolder("/tmp/herdr-demo/infra/")).toBe("infra");
    expect(greetingFolder("infra")).toBe("infra");
    expect(greetingFolder("~")).toBe("~");
  });

  test("a Windows path", () => {
    expect(greetingFolder("C:\\Users\\demo\\web app")).toBe("web app");
    expect(greetingFolder("C:\\Users\\demo\\web app\\")).toBe("web app");
    expect(greetingFolder("C:\\")).toBe("C:");
  });

  test("a root is itself", () => {
    expect(greetingFolder("/")).toBe("/");
  });

  test("no path", () => {
    expect(greetingFolder("")).toBe("");
    expect(greetingFolder(null)).toBe("");
    expect(greetingFolder(undefined)).toBe("");
  });
});

describe("composerLift", () => {
  test("the greeting and the composer end up centred in the stack", () => {
    const stack = 844; const composer = 110; const greeting = 70;
    const lift = composerLift(stack, composer, greeting);
    expect(lift).toBe(-332);
    const top = stack - composer - greeting + lift;
    const bottom = stack + lift;
    expect(top).toBe(stack - bottom);
  });

  test("never moves down, and stays put when both do not fit", () => {
    expect(composerLift(180, 110, 70)).toBe(0);
    expect(composerLift(120, 110, 70)).toBe(0);
    expect(composerLift(0, 0, 0)).toBe(0);
    expect(composerLift(Number.NaN, 110, 70)).toBe(0);
  });

  test("whole pixels", () => {
    expect(Number.isInteger(composerLift(801, 110, 70))).toBe(true);
  });
});
