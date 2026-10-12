import { describe, expect, it } from "bun:test";
import { LINE_ELEMENT_LIMIT } from "./highlight.ts";
import { lineRequest } from "./sourcePreview.ts";

describe("lineRequest", () => {
  it("marks visible lines, including the final empty source line", () => {
    expect(lineRequest(3, "a\nb\n", false)).toEqual({ kind: "shown", line: 3 });
    expect(lineRequest(2, "a\nb", true)).toEqual({ kind: "shown", line: 2 });
    expect(lineRequest(1, "", false)).toEqual({ kind: "shown", line: 1 });
  });
  it("distinguishes unseen preview text from a complete file's end", () => {
    expect(lineRequest(4, "a\nb\nc", true)).toEqual({ kind: "past-preview", line: 4 });
    expect(lineRequest(4, "a\nb\nc", false)).toEqual({ kind: "past-end", line: 4, lines: 3 });
  });
  it("marks at the element limit but refuses to mark an unnumbered preview", () => {
    expect(lineRequest(LINE_ELEMENT_LIMIT, "\n".repeat(LINE_ELEMENT_LIMIT - 1), false)).toEqual({ kind: "shown", line: LINE_ELEMENT_LIMIT });
    expect(lineRequest(5, "\n".repeat(LINE_ELEMENT_LIMIT), false)).toEqual({ kind: "unnumbered", line: 5 });
    expect(lineRequest(null, "\n".repeat(LINE_ELEMENT_LIMIT), true)).toBeNull();
  });
});
