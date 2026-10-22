import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ci.yml is the workflow that runs on pushes to main (windows-install.yml has no push trigger): each push gets
// its own concurrency group, so a later merge never replaces the queued run that says whether the earlier one broke main.
const workflows = ["ci.yml"];

function concurrency(file: string): { group: string; cancel: string } {
  const text = readFileSync(join(import.meta.dir, "..", ".github", "workflows", file), "utf8");
  const block = text.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
  return {
    group: block.match(/^\s+group:\s*(.+)$/m)?.[1]?.trim() ?? "",
    cancel: block.match(/^\s+cancel-in-progress:\s*(.+)$/m)?.[1]?.trim() ?? "",
  };
}

describe("main push concurrency", () => {
  for (const file of workflows) {
    it(`${file}: a push is grouped by its commit, a pull request by its branch`, () => {
      const { group, cancel } = concurrency(file);
      expect(group).toContain("github.event_name == 'push' && github.sha || github.ref");
      expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
    });
  }
});
