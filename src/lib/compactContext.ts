import type { SlashCommand } from "../../shared/protocol.ts";

/** `/<name>` when the pane's agent lists that slash command (its `/api/pane/commands` answer), else null. */
function listedCommandText(commands: readonly SlashCommand[], name: string): string | null {
  const found = commands.some((command) => command.name === name && (command.trigger ?? "/") === "/");
  return found ? `/${name}` : null;
}

/**
 * The text a Compact click sends, or null when the pane's agent does not list a `/compact`
 * command (its `/api/pane/commands` answer): the control is drawn only where it can work.
 */
export function compactCommandText(commands: readonly SlashCommand[]): string | null {
  return listedCommandText(commands, "compact");
}

/** The agents whose answer to `/model` or `/effort` the chat shows as a card; elsewhere the list waits in the terminal. */
const PICK_CARDS = { model: ["claude", "codex"], effort: ["claude"] } as const satisfies Record<string, readonly string[]>;

/**
 * The text a tap on the composer's model or effort label sends, or null where it would open no
 * card: an agent the chat has no card for, or one that does not list the command.
 */
export function pickCommandText(agent: string | null, commands: readonly SlashCommand[], pick: keyof typeof PICK_CARDS): string | null {
  return agent !== null && (PICK_CARDS[pick] as readonly string[]).includes(agent) ? listedCommandText(commands, pick) : null;
}
