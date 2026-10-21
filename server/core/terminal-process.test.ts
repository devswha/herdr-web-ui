import { describe, expect, it } from "bun:test";
import { attachScreenStarted } from "./terminal-process.ts";

describe("attachScreenStarted", () => {
  it("takes a screen at once and waits on anything a refusal line may start with", () => {
    const setup = "\x1b[?1000l\x1b[?1049h\x1b[0 q";
    expect(attachScreenStarted(setup)).toBe(false);
    expect(attachScreenStarted(`${setup}\x1b[H\x1b[2J`)).toBe(true);
    expect(attachScreenStarted(`${setup}\x1b[?1049l\x1b[?25h\x1b[0 qher`)).toBe(false);
    expect(attachScreenStarted(`${setup}\x1b[?1049l\x1b[?25h\x1b[0 qherdr: server shut down: terminal attach failed`)).toBe(false);
    expect(attachScreenStarted("terminal attach taken over\r\n")).toBe(false);
    expect(attachScreenStarted("pane text: has a read in progress; retry\r\n")).toBe(true);
  });
});
