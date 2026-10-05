import { describe, expect, test } from "bun:test";
import { NO_MEMORY, afterRead, afterSend, chatIsBlank, composerLift, greetingFits, greetingFolder, roomOverComposer, showsGreeting, type BlankChat, type ChatRead, type GreetingState } from "./greeting.ts";

const blank: BlankChat = { loaded: true, failed: false, transcript: true, turns: 0, abandoned: 0, prompt: false, agent: "claude" };
const read: ChatRead = { blank: true, turns: 0, history: "h1" };
const shown: GreetingState = { memory: afterRead(NO_MEMORY, read), agentStatus: "idle", queued: 0, folder: "infra" };

describe("chatIsBlank", () => {
  test("a loaded transcript with no turns is blank", () => {
    expect(chatIsBlank(blank)).toBe(true);
  });

  // also the moment a changed history is read again: ChatView drops its turns and is loading until the answer
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

  test("a chat that is not blank, or not read, is not", () => {
    expect(showsGreeting({ ...shown, memory: NO_MEMORY })).toBe(false);
    expect(showsGreeting({ ...shown, memory: afterRead(NO_MEMORY, { ...read, blank: false }) })).toBe(false);
    expect(showsGreeting({ ...shown, memory: afterRead(shown.memory, null) })).toBe(false);
  });

  test("the first message sent takes the greeting away before the transcript holds it", () => {
    expect(showsGreeting({ ...shown, memory: afterSend(shown.memory) })).toBe(false);
    expect(showsGreeting({ ...shown, memory: afterRead(afterSend(shown.memory), read) })).toBe(false);
  });

  test("a chat first read after the message went out is not greeted", () => {
    expect(showsGreeting({ ...shown, memory: afterRead(afterSend(NO_MEMORY), read) })).toBe(false);
  });

  test("the chat leaving the screen or a failed read does not bring the greeting back after a send", () => {
    const away = afterRead(afterSend(shown.memory), null);
    expect(away.sent).toBe(true);
    expect(showsGreeting({ ...shown, memory: afterRead(away, read) })).toBe(false);
    expect(showsGreeting({ ...shown, memory: afterRead(afterRead(afterRead(away, read), null), read) })).toBe(false);
  });

  test("a chat that was never sent to is greeted again when it comes back", () => {
    expect(showsGreeting({ ...shown, memory: afterRead(afterRead(shown.memory, null), read) })).toBe(true);
  });

  test("a conversation found blank again after its turns, or in a new history (a cleared one), is greeted again", () => {
    const answered = afterRead(afterSend(shown.memory), { blank: false, turns: 2, history: "h1" });
    expect(answered.sent).toBe(false);
    expect(showsGreeting({ ...shown, memory: afterRead(answered, read) })).toBe(true);
    const cleared = afterRead(afterSend(shown.memory), { ...read, history: "h2" });
    expect(showsGreeting({ ...shown, memory: cleared })).toBe(true);
  });

  test("a read that changes nothing keeps the same memory", () => {
    expect(afterRead(shown.memory, read)).toBe(shown.memory);
    expect(afterRead(NO_MEMORY, null)).toBe(NO_MEMORY);
    const sent = afterSend(shown.memory);
    expect(afterSend(sent)).toBe(sent);
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

describe("greetingFits", () => {
  test("the stack holds the composer and the greeting", () => {
    expect(greetingFits(844, 110, 70)).toBe(true);
    expect(greetingFits(180, 110, 70)).toBe(true);
  });

  test("a stack too short for both leaves the greeting out", () => {
    expect(greetingFits(140, 110, 70)).toBe(false);
    expect(greetingFits(Number.NaN, 110, 70)).toBe(false);
  });
});

describe("roomOverComposer", () => {
  test("from the stack's top to the input card of the lifted composer", () => {
    // a 400px stack, a 110px composer lifted 110px, its card 30px below its top
    expect(roomOverComposer(400, 110, composerLift(400, 110, 70), 30)).toBe(210);
  });

  test("docked, it is everything over the card", () => {
    expect(roomOverComposer(844, 110, 0, 30)).toBe(764);
  });

  test("never negative", () => {
    expect(roomOverComposer(100, 140, 0, 30)).toBe(0);
  });
});
