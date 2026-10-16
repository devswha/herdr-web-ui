import { join } from "node:path";
import type { AgentCommandSource } from "./index.ts";
import { piAgentDir } from "../pi-models.ts";
import { piTemplates, skills } from "./walk.ts";

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "<provider/model> — Select model", thinking: "<level> — Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "<provider> — Configure provider authentication",
  logout: "Remove provider authentication", llama: "[t] Manage llama.cpp router models", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session as a secret GitHub gist",
  bug: "<description> — Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi",
};

export const source: AgentCommandSource = {
  // pi 0.87.1, as its own palette lists them, less /tree — the way omp's list curates its own
  // commands. The chat reads pi's tree browser as nothing at all: no card, and the pane still looks
  // idle while the terminal waits for arrow keys. Offering the one command that opens it from the
  // chat would walk a reader into a state only the terminal lens can leave. Navigating stays in the
  // terminal; the chat's place is the abandoned-turns marker, which says where a /tree left off
  builtins: ["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"],
  descriptions: PI_DESCRIPTIONS,
  discover({ home }) {
    // Only what pi loads from the person's own folders, which it loads whether or not the
    // folder's project is trusted: the agent directory and ~/.agents. A project's own skills
    // and prompts are left out on purpose — pi gates them behind a trust decision and a
    // project root of its own choosing, and offering a command the agent will not run is worse
    // than offering one fewer command. Neither are pi's packages and extension commands, which
    // no file scan can know: they are in the terminal's own `/` menu either way.
    // PI_CODING_AGENT_DIR moves the agent directory, as it does for pi's sessions and models
    const agentDir = process.env["PI_CODING_AGENT_DIR"] ? piAgentDir() : join(home, ".pi", "agent");
    return [
      ...piTemplates(join(agentDir, "prompts"), "user"),
      ...skills(join(agentDir, "skills"), "skill", { prefix: "skill" }),
      ...skills(join(home, ".agents", "skills"), "skill", { prefix: "skill" }),
    ];
  },
};
