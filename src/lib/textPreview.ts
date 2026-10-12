import type { InlineNode, MarkdownBlock } from "./markdown.ts";

/** How the viewer shows a text file: chosen in its header, Preview unless the user asked for the source. */
export type TextViewMode = "preview" | "code";

/** Whether a file in `language` has a rendered Preview besides its source: Markdown does. */
export function hasPreview(language: string | null): boolean {
  return language === "markdown";
}

/**
 * How many elements a Preview may draw. Its parse runs in a worker, but drawing is on the page: in
 * Chromium a list of 65 536 items held it for 1.6 s, where 20 000 elements take about 0.3 s. A file
 * past it opens as its source, "Too long to preview".
 */
export const PREVIEW_ELEMENT_LIMIT = 20_000;

/** How many elements inline nodes draw: each but plain text, which costs next to nothing, and what it holds. */
function inlineElements(nodes: readonly InlineNode[]): number {
  let count = 0;
  for (const node of nodes) count += (node.type === "text" ? 0 : 1) + ("children" in node ? inlineElements(node.children) : 0);
  return count;
}

/**
 * About how many elements `blocks` draw as a Preview: each block, line, list item and table cell
 * with its inline elements, and a code block as the lines it shows folded (at most 30).
 */
export function previewElements(blocks: readonly MarkdownBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if (block.type === "heading") count += inlineElements(block.content);
    else if (block.type === "paragraph") for (const line of block.lines) count += 1 + inlineElements(line);
    else if (block.type === "list") for (const item of block.items) count += 1 + inlineElements(item.content) + previewElements(item.blocks ?? []);
    else if (block.type === "blockquote") count += previewElements(block.blocks);
    else if (block.type === "table") for (const row of [block.header, ...block.rows]) for (const cell of row) count += 1 + inlineElements(cell);
    else if (block.type === "code") count += Math.min(30, block.value.split("\n").length);
  }
  return count;
}
