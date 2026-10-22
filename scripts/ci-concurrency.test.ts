import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ci.yml is the workflow that runs on pushes to main (windows-install.yml has no push trigger). Each push gets its
// own concurrency group, so a later merge never replaces the queued run that says whether the earlier one broke main;
// a pull request keeps one group per branch and cancels its superseded run.
type Workflow = { on: { push?: { branches?: string[] } }; concurrency: { group: string; "cancel-in-progress": string } };
const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8")) as Workflow;

type Context = { workflow: string; event_name: string; ref: string; sha: string };
// evaluates the ${{ }} parts of a concurrency value: only github.* lookups, ==, && and || with string literals
function evaluate(template: string, github: Context): string {
  return template.replace(/\$\{\{([^}]*)\}\}/g, (_, expression: string) => {
    const js = expression.trim().replace(/github\.(\w+)/g, (_m, key: keyof Context) => JSON.stringify(github[key]));
    if (!/^[\s"'\w./-]*(?:(?:==|&&|\|\|)[\s"'\w./-]*)*$/.test(js)) throw new Error(`unexpected expression: ${expression}`);
    return String(new Function(`return (${js});`)());
  });
}

const push = (sha: string): Context => ({ workflow: "CI", event_name: "push", ref: "refs/heads/main", sha });
const pr = (sha: string): Context => ({ workflow: "CI", event_name: "pull_request", ref: "refs/pull/7/merge", sha });

describe("ci.yml concurrency", () => {
  it("runs on pushes to main", () => {
    expect(ci.on.push?.branches).toContain("main");
  });

  it("gives every push to main its own group that no other push cancels", () => {
    const groups = ["a1", "b2", "c3"].map((sha) => evaluate(ci.concurrency.group, push(sha)));
    expect(new Set(groups).size).toBe(3);
    expect(evaluate(ci.concurrency["cancel-in-progress"], push("a1"))).toBe("false");
  });

  it("keeps one group per pull request and cancels its superseded run", () => {
    expect(evaluate(ci.concurrency.group, pr("a1"))).toBe(evaluate(ci.concurrency.group, pr("b2")));
    expect(evaluate(ci.concurrency.group, pr("a1"))).toContain("CI");
    expect(evaluate(ci.concurrency["cancel-in-progress"], pr("a1"))).toBe("true");
  });
});
