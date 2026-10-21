import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHerdrUi } from "./herdr-ui.ts";

describe("herdr's copy_on_select", () => {
  it.each([
    ["[ui]\ncopy_on_select = false", false],
    ["[ui]\ncopy_on_select = true", true],
    ["", true],
    ["[ui]\ntheme = 'dark'", true],
    ["[other]\ncopy_on_select = false", true],
    ["[ui]\ncopy_on_select = 'false'", true],
    ["[ui]\ncopy_on_select = 0", true],
    ["ui = false", true],
    ["[ui", true],
  ] as const)("reads %s with herdr's default for missing or invalid values", (contents, expected) => {
    const root = mkdtempSync(join(tmpdir(), "herdr-ui-config-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, contents);
      expect(readHerdrUi(path)).toEqual({ copy_on_select: expected });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults on when the config cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-ui-config-"));
    try {
      expect(readHerdrUi(join(root, "missing.toml")).copy_on_select).toBe(true);
      expect(readHerdrUi(root).copy_on_select).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
