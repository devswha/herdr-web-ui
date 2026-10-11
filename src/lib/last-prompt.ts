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

export function promptLine(prompt: SentPrompt, imagesLabel: (n: number) => string): string {
  const words = prompt.text.replace(/\s+/g, " ").trim();
  return words.length > 0 ? words : imagesLabel(prompt.images);
}
