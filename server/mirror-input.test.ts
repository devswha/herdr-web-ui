import { describe, expect, test } from "bun:test";
import { mirrorInput } from "./mirror-input.ts";

describe("typing into a mirrored pane", () => {
  test("a pasted block of lines reaches a Windows pane as one bracketed paste", () => {
    expect(mirrorInput("line one\rline two", true)).toBe("\x1b[200~line one\rline two\x1b[201~");
    expect(mirrorInput("line one\r\rline three\r", true)).toBe("\x1b[200~line one\r\rline three\r\x1b[201~");
    expect(mirrorInput("line one\nline two", true)).toBe("\x1b[200~line one\nline two\x1b[201~");
  });

  test("keys and a line that ends in Enter go as they were typed", () => {
    for (const typed of ["a", "한", "\r", "\x03", "\x1b", "\t", "\x1b[A", "\x1bOA", "echo a\r", "\r\r"]) {
      expect(mirrorInput(typed, true)).toBe(typed);
    }
  });

  test("a pasted block that holds an escape byte, as coloured output does, is still one paste", () => {
    expect(mirrorInput("\x1b[31mline one\x1b[0m\rline two", true)).toBe("\x1b[200~\x1b[31mline one\x1b[0m\rline two\x1b[201~");
  });

  test("a paste the terminal already bracketed is not wrapped again", () => {
    const pasted = "\x1b[200~line one\rline two\x1b[201~";
    expect(mirrorInput(pasted, true)).toBe(pasted);
  });

  test("a herdr that hands the bytes to the program as they are gets them untouched", () => {
    expect(mirrorInput("line one\rline two", false)).toBe("line one\rline two");
  });
});
