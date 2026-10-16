import { join } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { customCommands, skills } from "./walk.ts";


export const source: AgentCommandSource = {
  builtins: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
  discover({ home, cwd }) {
    // Codex's saved prompts run as /prompts:<name>; its skills are named with `$`.
    return [
      ...customCommands(join(home, ".codex", "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` })),
      ...skills(join(home, ".codex", "skills"), "skill", { trigger: "$" }),
      ...(cwd ? skills(join(cwd, ".codex", "skills"), "skill", { trigger: "$" }) : []),
    ];
  },
};
