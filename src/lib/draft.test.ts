import { describe, expect, it } from "bun:test";
import { applyToDraft, draftIsEmpty, EMPTY_DRAFT } from "./draft.ts";

describe("applyToDraft", () => {
  it("appends a printable character to the draft", () => {
    expect(applyToDraft(EMPTY_DRAFT, "a")).toEqual({ text: "a" });
  });

  it("keeps the order of consecutive typed characters", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "l"), "s");
    expect(draft.text).toBe("ls");
  });

  it("leaves a special key out of the draft", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "x"), "\r");
    expect(draft).toEqual({ text: "x" });
  });

  it("holds nothing for escape sequences, arrows, control codes and DEL: there is nothing to send", () => {
    // also what xterm answers a program by itself: a cursor position, a focus or a mouse report
    for (const special of ["\u001b[A", "\u0003", "\u001b", "\t", "\u007f", "\u001b[12;40R", "\u001b[I", "\u001b[<35;10;5M"]) {
      const draft = applyToDraft(EMPTY_DRAFT, special);
      expect(draft).toBe(EMPTY_DRAFT);
      expect(draftIsEmpty(draft)).toBe(true);
    }
  });

  it("caps the draft instead of growing without bound", () => {
    let draft = EMPTY_DRAFT;
    for (let i = 0; i < 1100; i += 1) draft = applyToDraft(draft, "x");
    expect(draft.text.length).toBe(1024);
  });
});

describe("draftIsEmpty", () => {
  it("is true for the empty draft and false once text is held", () => {
    expect(draftIsEmpty(EMPTY_DRAFT)).toBe(true);
    expect(draftIsEmpty({ text: "a" })).toBe(false);
  });
});

it("holds multi-codepoint IME commits without splitting a surrogate at the limit", () => {
  for (const text of ["한글", "😀", "e\u0301", "abc"]) expect(applyToDraft(EMPTY_DRAFT, text).text).toBe(text);
  expect(applyToDraft({ text: "a".repeat(1023) }, "😀").text).toHaveLength(1023);
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text\x1b[201~").text).toBe("");
});
