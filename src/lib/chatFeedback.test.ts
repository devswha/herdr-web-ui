import { describe, expect, it } from "bun:test";
import { showThinking } from "./chatFeedback.ts";

describe("authoritative thinking feedback", () => {
  const working = { connected: true, ended: false, agentStatus: "working", lastRole: "user" } as const;

  it("shows work before an assistant turn, including an empty transcript", () => {
    expect(showThinking(working)).toBe(true);
    expect(showThinking({ ...working, lastRole: undefined })).toBe(true);
    expect(showThinking({ ...working, lastRole: "assistant" })).toBe(false);
  });

  it("does not infer work from an idle, blocked, unknown or completed agent", () => {
    for (const agentStatus of ["idle", "blocked", "done", "unknown", undefined]) {
      expect(showThinking({ ...working, agentStatus })).toBe(false);
    }
  });

  it("never leaves thinking feedback on a disconnected or ended pane", () => {
    expect(showThinking({ ...working, connected: false })).toBe(false);
    expect(showThinking({ ...working, ended: true })).toBe(false);
  });
});
