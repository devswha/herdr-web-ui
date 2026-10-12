import { countLines, LINE_ELEMENT_LIMIT } from "./highlight.ts";

/** Whether a requested source line can be marked, without pretending to jump to unseen text. */
export type LineRequest =
  | { readonly kind: "shown"; readonly line: number }
  | { readonly kind: "past-preview"; readonly line: number }
  | { readonly kind: "past-end"; readonly line: number; readonly lines: number }
  | { readonly kind: "unnumbered"; readonly line: number };

export function lineRequest(line: number | null, source: string, truncated: boolean): LineRequest | null {
  if (line === null) return null;
  const lines = countLines(source);
  if (lines > LINE_ELEMENT_LIMIT) return { kind: "unnumbered", line };
  if (line <= lines) return { kind: "shown", line };
  return truncated ? { kind: "past-preview", line } : { kind: "past-end", line, lines };
}
