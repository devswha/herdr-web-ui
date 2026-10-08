import { describe, expect, it } from "bun:test";

import { markdownImagePath } from "./markdownImages.ts";

describe("markdownImagePath", () => {
  it("reads a relative path from the markdown file's folder", () => {
    expect(markdownImagePath("img/a.png", "/tmp/doc/README.md")).toBe("/tmp/doc/img/a.png");
    expect(markdownImagePath("./a.png?raw=1#x", "/tmp/doc/README.md")).toBe("/tmp/doc/a.png");
    expect(markdownImagePath("../a%20b.png", "/tmp/doc/README.md")).toBe("/tmp/a b.png");
  });
  it("keeps an absolute path and a file URI", () => {
    expect(markdownImagePath("/var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    expect(markdownImagePath("file:///var/x.png", "/tmp/doc/README.md")).toBe("/var/x.png");
    // decoded once: the `%` that `%25` stands for is not read as an escape again
    expect(markdownImagePath("file:///tmp/100%25.png", "/tmp/a.md")).toBe("/tmp/100%.png");
  });
  it("refuses what the page cannot load or place", () => {
    expect(markdownImagePath("https://x.dev/a.png", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("data:image/png;base64,AA", "/tmp/a.md")).toBeNull();
    expect(markdownImagePath("a.png", "a.md")).toBeNull();
    expect(markdownImagePath("~/a.png", "/tmp/a.md")).toBeNull();
  });
});
