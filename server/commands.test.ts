import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommands } from "./commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("paneCommands", () => {
  it("returns sorted built-ins for supported agents and none for unknown agents", () => {
    const claude = paneCommands("claude", null, temp("commands-home-"));
    expect(claude.some((command) => command.name === "clear" && command.source === "builtin")).toBeTrue();
    expect(claude.map((command) => command.name)).toEqual([...claude.map((command) => command.name)].sort());
    expect(paneCommands("unknown", "/tmp")).toEqual([]);
    expect(paneCommands(null, "/tmp")).toEqual([]);
  });

  it("loads user and nested project Claude commands with descriptions", () => {
    const home = temp("commands-home-");
    const cwd = temp("commands-project-");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "commands", "team"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy safely\n---\nignored body\n");
    writeFileSync(join(cwd, ".claude", "commands", "team", "review.md"), "\nReview this project thoroughly\nMore detail");

    const commands = paneCommands("claude", cwd, home);
    expect(commands).toContainEqual({ name: "deploy", description: "Deploy safely", source: "user" });
    expect(commands).toContainEqual({ name: "team:review", description: "Review this project thoroughly", source: "project" });
  });
});

describe("skills and plugins", () => {
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

  it("offers Claude's skills, user and project, and the enabled plugins' skills and commands", () => {
    const home = temp("skills-home-");
    const cwd = temp("skills-cwd-");
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: Rewrite AI prose\n---\n");
    write(join(home, ".claude", "skills", "notes", "README.md"), "no SKILL.md: not a skill");
    write(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ship it\n---\n");
    const plugin = join(home, ".claude", "plugins", "cache", "market", "hud", "1.0.0");
    write(join(plugin, "skills", "setup", "SKILL.md"), "---\nname: setup\ndescription: Configure the HUD\n---\n");
    write(join(plugin, "commands", "configure.md"), "---\ndescription: Configure options\n---\n");
    const off = join(home, ".claude", "plugins", "cache", "market", "off", "1.0.0");
    write(join(off, "skills", "hidden", "SKILL.md"), "---\nname: hidden\n---\n");
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "hud@market": [{ installPath: plugin }], "off@market": [{ installPath: off }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": true, "off@market": false } }));
    const extra = paneCommands("claude", cwd, home).filter((command) => command.source === "skill" || command.source === "plugin");
    expect(extra).toEqual([
      { name: "deploy", description: "Ship it", source: "skill" },
      { name: "hud:configure", description: "Configure options", source: "plugin" },
      { name: "hud:setup", description: "Configure the HUD", source: "plugin" },
      { name: "patina", description: "Rewrite AI prose", source: "skill" },
    ]);
  });

  it("offers Codex's saved prompts as /prompts:<name> and its skills with $", () => {
    const home = temp("codex-home-");
    write(join(home, ".codex", "prompts", "review.md"), "Review the diff\n");
    write(join(home, ".codex", "skills", "deepinit", "SKILL.md"), "---\nname: deepinit\ndescription: Deep codebase initialization\n---\n");
    const extra = paneCommands("codex", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toEqual([
      { name: "deepinit", description: "Deep codebase initialization", source: "skill", trigger: "$" },
      { name: "prompts:review", description: "Review the diff", source: "user" },
    ]);
  });
});
