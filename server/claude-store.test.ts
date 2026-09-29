import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, claudeTranscriptFile, forgetClaudeSessions } from "./claude-store.ts";

const SESSION = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";

describe("claudeProjectDir", () => {
  it("encodes a cwd the way Claude Code names its project", () => {
    expect(claudeProjectDir("/home/u/project")).toBe("-home-u-project");
    expect(claudeProjectDir("/home/u/Development/test.com")).toBe("-home-u-Development-test-com");
    expect(claudeProjectDir("/home/u/my_project")).toBe("-home-u-my-project");
    expect(claudeProjectDir("/home/u/.dotfiles")).toBe("-home-u--dotfiles");
    expect(claudeProjectDir("/home/u/문서/app")).toBe("-home-u----app");
    expect(claudeProjectDir("/home/u/My Project")).toBe("-home-u-My-Project");
  });

  it("cuts a name past 200 characters and adds the hash of the whole path", () => {
    const cwd = `/home/u/${"deep/".repeat(45)}project`;
    expect(claudeProjectDir(cwd)).toBe(`${"-home-u-" + "deep-".repeat(38)}de-5cuwtt`);
    expect(claudeProjectDir(cwd).length).toBe(207);
  });
});

describe("claudeTranscriptFile", () => {
  const roots: string[] = [];
  afterEach(() => { forgetClaudeSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function home(): { home: string; projects: string } {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-store-"));
    roots.push(home);
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    return { home, projects };
  }
  function transcript(projects: string, project: string): string {
    mkdirSync(join(projects, project), { recursive: true });
    const path = join(projects, project, `${SESSION}.jsonl`);
    writeFileSync(path, "{}\n");
    return path;
  }

  it("finds a session under a cwd with a dot, an underscore, a space or Korean", () => {
    for (const cwd of ["/w/example.com", "/w/my_project", "/w/My Project", "/w/문서/app", "/w/.dotfiles"]) {
      const { home: dir, projects } = home();
      const path = transcript(projects, claudeProjectDir(cwd));
      expect(claudeTranscriptFile(dir, SESSION, [cwd])).toBe(path);
    }
  });

  it("tries each cwd in turn, then finds the session in whichever project holds it", () => {
    const { home: dir, projects } = home();
    const started = transcript(projects, claudeProjectDir("/w/started-here"));
    expect(claudeTranscriptFile(dir, SESSION, ["/w/moved-on", null, "/w/started-here"])).toBe(started);
    // neither cwd names the project (Claude started elsewhere, or named it another way)
    renameSync(join(projects, claudeProjectDir("/w/started-here")), join(projects, "-some-other-name"));
    expect(claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBe(join(projects, "-some-other-name", `${SESSION}.jsonl`));
    // a remembered file that has gone is looked up again, not answered
    rmSync(join(projects, "-some-other-name"), { recursive: true });
    expect(claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBeNull();
  });

  it("answers null without a projects store or a file for the session", () => {
    const { home: dir } = home();
    expect(claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBeNull();
    expect(claudeTranscriptFile(join(dir, "missing"), SESSION, ["/w/project"])).toBeNull();
  });
});
