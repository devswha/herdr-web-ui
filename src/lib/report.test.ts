import { describe, expect, it } from "bun:test";

import { buildReport, ISSUE_URL_MAX, ISSUES_URL, issueUrl, reportTitle, reportTurns } from "./report.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

const environment = { app: "0.3.20", herdr: "0.9.0", machine: "local", agent: "claude", status: "idle", source: "claude-transcript" as const, model: "claude-opus-5-5", browser: "Chrome", viewport: "390x844" };

describe("problem report", () => {
  it("carries what was seen, where, and the pieces the chat is built from", () => {
    const turns: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "1. a\n\n2. b" }, { kind: "tool", name: "Bash", summary: "ls", input: "{}", output: "x".repeat(2000) }] }];
    const report = buildReport({ description: "numbers read 1. 1.", environment, turns, prompt: null, screen: "$ ls\n```weird```" });
    expect(report).toContain("## What went wrong\n\nnumbers read 1. 1.");
    expect(report).toContain("herdr web ui 0.3.20 · herdr 0.9.0 · PC local");
    expect(report).toContain('"text": "1. a\\n\\n2. b"');
    expect(report).toContain("_(no prompt on screen)_");
    // a screen with backticks gets a fence longer than any of them
    expect(report).toContain("````text\n$ ls\n```weird```\n````");
    expect(reportTurns(turns)[0]!.parts[1]).toMatchObject({ output: expect.stringContaining("(2000 characters)") });
  });

  it("leaves out what was not included", () => {
    const report = buildReport({ description: "", environment, turns: null, prompt: undefined, screen: null });
    expect(report).toContain("_(not described)_");
    expect(report).not.toContain("## Latest turns");
    expect(report).not.toContain("## Prompt card");
    expect(report).not.toContain("## Terminal screen");
  });

  it("titles an issue by the description's first line, and cuts a body too long for a URL", () => {
    expect(reportTitle("numbers look odd\nmore", "claude")).toBe("[claude] numbers look odd");
    expect(reportTitle("", null)).toBe("Problem report");
    const short = issueUrl("t", "body");
    expect(short.cut).toBe(false);
    expect(short.url.startsWith(`${ISSUES_URL}?`)).toBe(true);
    expect(new URL(short.url).searchParams.get("body")).toBe("body");
    const long = issueUrl("t", "y".repeat(ISSUE_URL_MAX + 500));
    expect(long.cut).toBe(true);
    expect(long.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(long.url).searchParams.get("body")).toContain("Please paste the full report");
  });
});

it("bounds the encoded address for Korean, emoji and reserved characters", () => {
  for (const value of ["한글", "😀", "&?#%", "ascii"]) {
    const result = issueUrl(value.repeat(500), value.repeat(2000));
    expect(result.cut).toBe(true);
    expect(result.url.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    expect(new URL(result.url).searchParams.get("body")).toContain("attach the saved Markdown file");
    expect(new URL(result.url).searchParams.get("title")).not.toContain("�");
  }
});
