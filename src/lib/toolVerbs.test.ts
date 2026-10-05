import { describe, expect, it } from "bun:test";

import { toolVerb, toolVerbKind } from "./toolVerbs.ts";

describe("toolVerbKind", () => {
  it("reads every agent's file and shell tools as one of four verbs", () => {
    const expected: Record<string, string> = {
      // Claude Code
      Read: "read", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Write: "write", Bash: "run",
      // Codex
      exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run", apply_patch: "edit",
      // pi, omp, gjc and omo name theirs in lowercase
      read: "read", edit: "edit", multiedit: "edit", patch: "edit", write: "write", bash: "run",
    };
    for (const [name, kind] of Object.entries(expected)) expect([name, toolVerbKind(name)]).toEqual([name, kind as ReturnType<typeof toolVerbKind>]);
  });

  it("leaves every other tool the chat knows under its own name", () => {
    const untouched = [
      // counted as a file read or a command in the header, but not a plain read or run
      "Grep", "grep", "Glob", "glob", "LS", "ls", "find", "list", "search", "eval", "run_command",
      // tools with their own row or panel
      "Skill", "Task", "Agent", "task", "WebFetch", "WebSearch", "webfetch", "web_search",
      "TodoWrite", "update_plan", "todo", "todo_write", "mcp__omo__todo",
      "create_goal", "update_goal", "get_goal", "request_user_input_async",
      // a name that only contains a known one
      "mcp__files__read_all", "read_mcp_resource", "BashOutput", "write_stdin", "tool",
    ];
    for (const name of untouched) expect([name, toolVerbKind(name)]).toEqual([name, null]);
  });

  it("calls a Codex exec that applies a patch an edit", () => {
    const script = 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch");';
    expect(toolVerbKind("exec", script)).toBe("edit");
    expect(toolVerbKind("exec", '{"cmd":"bun test"}')).toBe("run");
    // only a shell tool is re-read this way
    expect(toolVerbKind("Read", "*** Begin Patch\n*** End Patch")).toBe("read");
    expect(toolVerbKind("lookup", "*** Begin Patch\n*** End Patch")).toBeNull();
  });
});

describe("toolVerb", () => {
  const part = (name: string, input = "{}") => ({ name, input });

  it("is the verb a row shows before its object", () => {
    expect(toolVerb(part("Read"), "src/metrics.ts")).toBe("Read");
    expect(toolVerb(part("Edit"), "src/pages/Reports.tsx")).toBe("Edited");
    expect(toolVerb(part("apply_patch"), "src/pages/Reports.tsx")).toBe("Edited");
    expect(toolVerb(part("Write"), "notes.md")).toBe("Wrote");
    expect(toolVerb(part("exec"), "pnpm test")).toBe("Ran");
    expect(toolVerb(part("bash"), "pnpm test")).toBe("Ran");
  });

  it("keeps the tool id when there is nothing to put after the verb", () => {
    expect(toolVerb(part("Bash"), "")).toBeNull();
    // a call with no command or path is summed up by its own name
    expect(toolVerb(part("Bash"), "Bash")).toBeNull();
  });

  it("keeps the id of a tool it does not know", () => {
    expect(toolVerb(part("Grep"), "TODO")).toBeNull();
    expect(toolVerb(part("mcp__linear__create_issue"), "Fix the chart")).toBeNull();
  });
});
