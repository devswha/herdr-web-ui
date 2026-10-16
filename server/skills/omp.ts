import type { AgentCommandSource } from "./index.ts";


export const source: AgentCommandSource = {
  builtins: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  discover() {
    return [];
  },
};
