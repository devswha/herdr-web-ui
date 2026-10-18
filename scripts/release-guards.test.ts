import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "./release-guards.ts";

const made: string[] = [];
/** a throwaway identity, unsigned whatever the user's git config says */
const ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const run = (dir: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", dir, ...ID, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("check", () => {
  /** a repository released as 1.0.0 then changed by `edit` */
  function released(edit: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "hwc-release-"));
    made.push(dir);
    const git = (...args: string[]) => run(dir, ...args);
    const write = (files: Record<string, string>) => {
      for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); }
    };
    const metadata = (version: string) => ({
      "package.json": JSON.stringify({ version, dependencies: { a: "1" } }),
      "herdr-plugin.toml": `version = "${version}"\n`,
      "CHANGELOG.md": `## [Unreleased]\n\n## [${version}]\n\n- Fixed.\n`,
      "release-summaries.json": JSON.stringify({ [version]: Object.fromEntries(["en", "ko", "ja", "zh"].map((language) => [language, { fixed: ["Fixed."] }])) }),
    });
    write({ ...metadata("1.0.0"), "server/index.ts": "a", "src/App.tsx": "a" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "1.0.0");
    git("tag", "fork-v1.0.0");
    write(edit);
    git("add", "-A");
    git("commit", "-qm", "next");
    return dir;
  }
  const releasePr = (dir: string) => {
    const files = { "package.json": JSON.stringify({ version: "1.1.0", dependencies: { a: "1" } }), "herdr-plugin.toml": 'version = "1.1.0"\n' };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    writeFileSync(join(dir, "CHANGELOG.md"), "## [Unreleased]\n\n## [1.1.0]\n\n- New.\n\n## [1.0.0]\n\n- Fixed.\n");
    const summaries = JSON.parse(readFileSync(join(dir, "release-summaries.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "release-summaries.json"), JSON.stringify({ ...summaries, "1.1.0": summaries["1.0.0"] }));
    run(dir, "commit", "-qam", "release");
  };

  it("leaves any tree whose version is already released alone, whatever it changed", () => {
    expect(check(released({ "server/index.ts": "b" }), false)).toEqual({ version: null, problems: [] });
  });

  it("passes a release PR that changed only the client", () => {
    const dir = released({ "src/App.tsx": "b" });
    releasePr(dir);
    expect(check(dir, false)).toEqual({ version: "1.1.0", problems: [] });
  });

  it("requires patch notes in every supported language", () => {
    const dir = released({ "src/App.tsx": "patch notes fixture" });
    releasePr(dir);
    writeFileSync(join(dir, "release-summaries.json"), "{}");
    expect(check(dir, false).problems[0]).toContain("release-summaries.json must tell this version in: en, ko, ja, zh.");
  });
});
