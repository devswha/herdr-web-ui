import type { ConversationTurn } from "../../shared/protocol.ts";

/**
 * What changes when a turn's content does. Each poll parses the page anew, so a turn that did not
 * change is still a new object: keyed on the object, a message the chat could not draw was drawn
 * (and failed, and logged) again on every poll that changed some other turn.
 */
export function turnRevision(turn: ConversationTurn): string {
  let size = 0;
  for (const part of turn.parts) {
    if (part.kind === "text" || part.kind === "thinking" || part.kind === "compact" || part.kind === "notice") size += part.text.length;
    else if (part.kind === "tool") size += part.input.length + part.output.length + (part.error ? 1 : 0) + (part.images?.length ?? 0);
    else size += 1;
  }
  return `${turn.role}|${turn.ts ?? ""}|${turn.end_ts ?? ""}|${turn.parts.length}|${size}`;
}
