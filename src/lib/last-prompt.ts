import type { ConversationTurn } from "../../shared/protocol.ts";

/** A recorded user prompt, never an in-flight send or a queued receipt. */
export interface SentPrompt {
  text: string;
  images: number;
}

export function promptOf(turn: ConversationTurn): SentPrompt | null {
  if (turn.role !== "user") return null;
  if (turn.parts.some((part) => part.kind === "compact" || part.kind === "notice" || part.kind === "task_result")) return null;
  const text = turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n\n").trim();
  const images = turn.parts.filter((part) => part.kind === "image").length;
  return text.length > 0 || images > 0 ? { text, images } : null;
}

/** The nearest actual user prompt before a turn, within the loaded history. */
export function promptIndexBefore(turns: readonly ConversationTurn[], index: number): number {
  for (let at = Math.min(index, turns.length) - 1; at >= 0; at--) {
    const turn = turns[at];
    if (turn !== undefined && promptOf(turn) !== null) return at;
  }
  return -1;
}

export function lastPromptIndex(turns: readonly ConversationTurn[]): number {
  return promptIndexBefore(turns, turns.length);
}

export function promptLine(prompt: SentPrompt, imagesLabel: (n: number) => string): string {
  const words = prompt.text.replace(/\s+/g, " ").trim();
  return words.length > 0 ? words : imagesLabel(prompt.images);
}
