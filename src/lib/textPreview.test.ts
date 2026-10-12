import { describe, expect, it } from "bun:test";
import { parseMarkdown } from "./markdown.ts";
import { TEXT_PREVIEW_BYTES } from "./filePreviewText.ts";
import { hasPreview, PREVIEW_ELEMENT_LIMIT, previewElements } from "./textPreview.ts";

describe("hasPreview", () => {
  it("gives only Markdown a Preview", () => {
    expect(hasPreview("markdown")).toBe(true);
    expect(hasPreview("typescript")).toBe(false);
    expect(hasPreview(null)).toBe(false);
  });
});

describe("previewElements", () => {
  it("counts blocks, lines, items, cells and inline elements, and a code block as it shows folded", () => {
    // plain text is no element
    expect(previewElements(parseMarkdown("# Title"))).toBe(1);
    expect(previewElements(parseMarkdown("one **two**\nthree"))).toBe(1 + (1 + 1) + 1);
    expect(previewElements(parseMarkdown("- a\n- b\n  - c"))).toBe(1 + 1 + (1 + 1 + 1));
    expect(previewElements(parseMarkdown("| a | b |\n| --- | --- |\n| c | d |"))).toBe(1 + 4);
    expect(previewElements(parseMarkdown("> - a"))).toBe(1 + 1 + 1);
    expect(previewElements(parseMarkdown(`\`\`\`\n${"x\n".repeat(500)}\`\`\``))).toBe(1 + 30);
  });

  it("puts a file of the load limit's short list items past what a Preview draws", () => {
    expect(previewElements(parseMarkdown("- a\n".repeat(TEXT_PREVIEW_BYTES / 4)))).toBeGreaterThan(PREVIEW_ELEMENT_LIMIT);
    // ordinary notes of the same size stay well under it
    expect(previewElements(parseMarkdown("A paragraph of ordinary notes, with *emphasis* and a [link](./notes.txt).\n\n".repeat(TEXT_PREVIEW_BYTES / 80)))).toBeLessThan(PREVIEW_ELEMENT_LIMIT);
  });
});
