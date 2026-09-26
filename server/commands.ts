import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { SlashCommand } from "../shared/protocol.ts";

const BUILTINS: Record<string, readonly string[]> = {
  claude: ["clear", "compact", "config", "cost", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  omp: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  codex: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
};

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
};

function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}

/** Skills under a root: one directory each, with a SKILL.md; `prefix` names a plugin's. */
function skills(root: string, source: SlashCommand["source"], options: { prefix?: string; trigger?: "$" } = {}): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = join(root, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    let markdown: string;
    try { markdown = readFileSync(file, "utf8"); } catch { continue; }
    const name = skillName(markdown, entry.name);
    result.push({ name: options.prefix ? `${options.prefix}:${name}` : name, description: description(markdown), source, ...(options.trigger ? { trigger: options.trigger } : {}) });
  }
  return result;
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(home: string): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(home, ".claude", "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...skills(join(installPath, "skills"), "plugin", { prefix: plugin }));
    result.push(...customCommands(join(installPath, "commands"), "plugin").map((command) => ({ ...command, name: `${plugin}:${command.name}` })));
  }
  return result;
}

function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
        result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
      }
    }
  };
  visit(root);
  return result;
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME ?? ""): SlashCommand[] {
  if (!agent || !(agent in BUILTINS)) return [];
  const commands: SlashCommand[] = (BUILTINS[agent] ?? []).map((name) => ({ name, description: DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin" }));
  if (agent === "claude") {
    commands.push(...customCommands(join(home, ".claude", "commands"), "user"));
    if (cwd) commands.push(...customCommands(join(cwd, ".claude", "commands"), "project"));
    commands.push(...skills(join(home, ".claude", "skills"), "skill"));
    if (cwd) commands.push(...skills(join(cwd, ".claude", "skills"), "skill"));
    commands.push(...pluginCommands(home));
  }
  if (agent === "codex") {
    // Codex's saved prompts run as /prompts:<name>; its skills are named with `$`
    commands.push(...customCommands(join(home, ".codex", "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` })));
    commands.push(...skills(join(home, ".codex", "skills"), "skill", { trigger: "$" }));
    if (cwd) commands.push(...skills(join(cwd, ".codex", "skills"), "skill", { trigger: "$" }));
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
