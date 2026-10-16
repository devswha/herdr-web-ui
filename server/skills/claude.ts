import { join } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { readFileSync } from "node:fs";
import { customCommands, skills } from "./walk.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

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


export const source: AgentCommandSource = {
  builtins: ["clear", "compact", "config", "cost", "effort", "goal", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  discover({ home, cwd }) {
    return [
      ...customCommands(join(home, ".claude", "commands"), "user"),
      ...(cwd ? customCommands(join(cwd, ".claude", "commands"), "project") : []),
      ...skills(join(home, ".claude", "skills"), "skill"),
      ...(cwd ? skills(join(cwd, ".claude", "skills"), "skill") : []),
      ...pluginCommands(home),
    ];
  },
};
