/**
 * What a new agent's launch may carry from the new workspace and tab dialogs (#774, #1311): a model, an
 * effort level, a first prompt on Codex's command line, and a first message the bridge queues. The
 * dialog (src/lib/agentLaunchMode.ts), the bridge's create routes (server/agent-launch.ts,
 * server/workspace-routes.ts) and the demo's transport all check them by these rules, so what the
 * dialog lets through is what the bridge takes.
 */

/**
 * Claude Code's `--effort` levels: "Options: low, medium, high, xhigh, max, or ultracode. Available
 * levels depend on the model." (code.claude.com/docs/en/cli-reference, read 2026-10-20)
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
/**
 * Codex's `model_reasoning_effort` levels: "such as low, medium, high, xhigh, max, or ultra. Available
 * levels depend on the model and client." (developers.openai.com/codex/config-reference, read 2026-10-20)
 */
export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

/**
 * A model name as the CLIs take it after `--model`: one word that never reads as a flag, with an
 * optional bracketed variant such as Claude Code's `[1m]` context window (`opus[1m]`).
 */
export const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]*(?:\[[A-Za-z0-9]+\])?$/;

/** the most a first message (and a queued chat message, server/core/composer.ts pendingText) may hold */
export const MAX_FIRST_MESSAGE_CHARS = 20_000;

/** terminal control characters a queued message may not carry; TAB, LF and CR are text there */
const MESSAGE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
/** every control character, TAB and line breaks included: one argument on a command line is one line */
const ARGUMENT_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Whether `text` can go on an agent's command line as one argument. */
export const argumentText = (text: string): boolean => !ARGUMENT_CONTROLS.test(text);

/** What is wrong with a create request's `first_message`, in the API's words; null when it can be queued (or there is none). */
export function firstMessageFault(value: unknown, agent: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "first_message must be a string";
  if (value.trim() === "" || value.length > MAX_FIRST_MESSAGE_CHARS) return `first_message must contain text and be at most ${MAX_FIRST_MESSAGE_CHARS} characters`;
  if (MESSAGE_CONTROLS.test(value)) return "first_message must not contain terminal control characters";
  if (!agent) return "first_message needs an agent to send it to";
  return null;
}

/**
 * What is wrong with an agent's launch arguments, in the API's words; null when they can be passed. No
 * argument may hold a control character. Claude Code's and Codex's model and effort flags take only
 * the values the dialog offers, and Codex's prompt after `--` follows a first message's rules.
 */
export function launchArgsFault(kind: string, args: readonly string[]): string | null {
  if (!args.every(argumentText)) return "agent.args must not contain control characters (a tab or a line break included)";
  if (kind !== "claude" && kind !== "codex") return null;
  const efforts: readonly string[] = kind === "claude" ? CLAUDE_EFFORTS : CODEX_EFFORTS;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") {
      if (kind !== "codex") break;
      const prompt = args.slice(at + 1);
      if (prompt.length !== 1 || firstMessageFault(prompt[0], true) !== null) return "agent.args must end in one prompt after --, nonempty text of at most 20000 characters";
      break;
    }
    if (arg === "--model" && !MODEL_NAME.test(args[at + 1] ?? "")) return "agent.args --model must name one model";
    if (kind === "claude" && arg === "--effort" && !efforts.includes(args[at + 1] ?? "")) return `agent.args --effort must be one of ${efforts.join(", ")}`;
    if (kind === "codex" && arg === "-c" && (args[at + 1] ?? "").startsWith("model_reasoning_effort=")
      && !efforts.includes(args[at + 1]!.slice("model_reasoning_effort=".length))) return `agent.args model_reasoning_effort must be one of ${efforts.join(", ")}`;
  }
  return null;
}
