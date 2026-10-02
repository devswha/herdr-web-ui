import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { pasteDirectory } from "./paste.ts";

describe("pasteDirectory", () => {
  const previous = process.env["HERDR_WEB_PASTE_DIR"];
  afterEach(() => {
    if (previous === undefined) delete process.env["HERDR_WEB_PASTE_DIR"]; else process.env["HERDR_WEB_PASTE_DIR"] = previous;
  });

  it("keeps attachments next to the pane, or in the temp dir without a cwd", () => {
    delete process.env["HERDR_WEB_PASTE_DIR"];
    expect(pasteDirectory("/work/repo")).toBe(join("/work/repo", ".herdr-web-ui"));
    expect(pasteDirectory(null)).toBe(join(tmpdir(), "herdr-web-ui", ".herdr-web-ui"));
  });

  it("uses HERDR_WEB_PASTE_DIR for every pane when set, as an absolute path", () => {
    process.env["HERDR_WEB_PASTE_DIR"] = "/var/tmp/pastes";
    expect(pasteDirectory("/work/repo")).toBe(resolve("/var/tmp/pastes"));
    expect(pasteDirectory(undefined)).toBe(resolve("/var/tmp/pastes"));
    process.env["HERDR_WEB_PASTE_DIR"] = "pastes";
    expect(pasteDirectory("/work/repo")).toBe(resolve("pastes"));
  });

  it("treats an empty HERDR_WEB_PASTE_DIR as unset", () => {
    process.env["HERDR_WEB_PASTE_DIR"] = "";
    expect(pasteDirectory("/work/repo")).toBe(join("/work/repo", ".herdr-web-ui"));
  });
});
