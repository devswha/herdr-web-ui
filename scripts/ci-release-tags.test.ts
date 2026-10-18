import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const script = join(import.meta.dir, "ci-release-tags.sh");
const made: string[] = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
const identity = ["-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...identity, ...args], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture(tags: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-ci-release-tags-"));
  made.push(directory);
  const upstream = join(directory, "upstream");
  const checkout = join(directory, "checkout");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  writeFileSync(join(upstream, "fixture.txt"), "local release fixture\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "initial");
  for (const tag of tags) git(upstream, "tag", "-a", "-m", tag, tag);
  git(directory, "clone", "--quiet", "--no-tags", "--depth=1", pathToFileURL(upstream).href, checkout);
  return { directory, upstream, checkout };
}

function fetchTags(checkout: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [script], { cwd: checkout, env: { ...env, ...extraEnv }, encoding: "utf8" });
}

afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CI fork release tag discovery", () => {
  it("passes a new fork without release tags", () => {
    const { checkout } = fixture();
    const result = fetchTags(checkout);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No fork release tags");
    expect(git(checkout, "tag", "--list")).toBe("");
  });

  it("ignores inherited upstream tags when no fork release exists", () => {
    const { checkout } = fixture(["v0.4.11", "remote-v30"]);
    const result = fetchTags(checkout);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No fork release tags");
    expect(git(checkout, "tag", "--list")).toBe("");
  });

  for (const tags of [["fork-v0.4.12"], ["fork-v0.4.12", "fork-v0.4.13"]]) {
    it(`fetches published ${tags.join(" and ")} without upstream tags`, () => {
      const { upstream, checkout } = fixture([...tags, "v99.0.0", "remote-v99"]);
      const result = fetchTags(checkout);
      expect(result.status, result.stderr).toBe(0);
      expect(git(checkout, "tag", "--list").split("\n").sort()).toEqual([...tags].sort());
      for (const tag of tags) expect(git(checkout, "rev-parse", `${tag}^{commit}`)).toBe(git(upstream, "rev-parse", "HEAD"));
    });
  }

  it("fails rather than treating an unreadable remote as a tagless fork", () => {
    const { directory, checkout } = fixture();
    git(checkout, "remote", "set-url", "origin", join(directory, "missing-remote"));
    const result = fetchTags(checkout);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("No fork release tags");
  });

  it("propagates a fetch failure after successful release discovery", () => {
    const { directory, checkout } = fixture(["fork-v0.4.12"]);
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("Git is required for release-tag fixtures");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$1" = fetch ]; then echo "fixture fetch failure" >&2; exit 37; fi\nexec "$REAL_GIT" "$@"\n', { mode: 0o755 });
    const result = fetchTags(checkout, { PATH: `${bin}:${process.env["PATH"] ?? ""}`, REAL_GIT: realGit });
    expect(result.status).toBe(37);
    expect(result.stderr).toContain("fixture fetch failure");
    expect(git(checkout, "tag", "--list")).toBe("");
  });
});
