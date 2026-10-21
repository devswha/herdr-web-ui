import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "./update-state.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const configHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ovis-state-dir-"));
  roots.push(root);
  return root;
};

describe("the state dir from before the rename", () => {
  it("moves to its new name on first use, leaving a link at the old name", () => {
    const config = configHome();
    mkdirSync(join(config, "herdr-web-ui"));
    writeFileSync(join(config, "herdr-web-ui", "devices.json"), "{\"paired\":1}");
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(readFileSync(join(config, "ovis", "devices.json"), "utf8")).toBe("{\"paired\":1}");
    expect(lstatSync(join(config, "herdr-web-ui")).isSymbolicLink()).toBe(true);
    // through the link, an older release still finds the same files
    expect(readFileSync(join(config, "herdr-web-ui", "devices.json"), "utf8")).toBe("{\"paired\":1}");
  });

  it("is left alone once the new dir exists", () => {
    const config = configHome();
    mkdirSync(join(config, "herdr-web-ui"));
    mkdirSync(join(config, "ovis"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  });

  it("is not created for a fresh install", () => {
    const config = configHome();
    expect(defaultStateDir({ XDG_CONFIG_HOME: config })).toBe(join(config, "ovis"));
    expect(existsSync(join(config, "herdr-web-ui"))).toBe(false);
  });

  it("gives way to OVIS_STATE_DIR", () => {
    const config = configHome();
    mkdirSync(join(config, "herdr-web-ui"));
    expect(defaultStateDir({ XDG_CONFIG_HOME: config, OVIS_STATE_DIR: "/srv/ovis" })).toBe("/srv/ovis");
    expect(lstatSync(join(config, "herdr-web-ui")).isDirectory()).toBe(true);
  });
});
