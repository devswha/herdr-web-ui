import { describe, expect, test } from "bun:test";

import type { SlashCommand } from "../../shared/protocol.ts";
import { compactCommandText, pickCommandText } from "./compactContext.ts";

const command = (name: string, trigger?: "$"): SlashCommand => ({ name, description: "", source: "builtin", ...(trigger ? { trigger } : {}) });

describe("compactCommandText", () => {
  test("names the slash command when the agent lists compact", () => {
    expect(compactCommandText([command("model"), command("compact")])).toBe("/compact");
  });
  test("is null when the agent lists no compact", () => {
    expect(compactCommandText([command("model"), command("compaction")])).toBeNull();
    expect(compactCommandText([])).toBeNull();
  });
  test("ignores a $-skill named compact", () => {
    expect(compactCommandText([command("compact", "$")])).toBeNull();
  });
});

describe("pickCommandText", () => {
  const listed = [command("model"), command("effort"), command("compact")];
  test("names /model for Claude Code and Codex, and /effort for Claude Code", () => {
    expect(pickCommandText("claude", listed, "model")).toBe("/model");
    expect(pickCommandText("codex", listed, "model")).toBe("/model");
    expect(pickCommandText("claude", listed, "effort")).toBe("/effort");
  });
  test("is null for an agent the chat shows no card for", () => {
    expect(pickCommandText("codex", listed, "effort")).toBeNull();
    expect(pickCommandText("pi", listed, "model")).toBeNull();
    expect(pickCommandText(null, listed, "model")).toBeNull();
  });
  test("is null when the agent does not list the command", () => {
    expect(pickCommandText("claude", [command("compact")], "model")).toBeNull();
    expect(pickCommandText("claude", [command("effort", "$")], "effort")).toBeNull();
  });
});
