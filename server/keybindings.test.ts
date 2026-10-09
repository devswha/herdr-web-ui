import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrConfigPath, keybindingsResponse, readKeymap } from "./keybindings.ts";
import { mergeHerdrKeymap, readHerdrKeymap } from "../shared/herdr-keymap.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function config(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-keymap-unit-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

describe("Herdr keymap read API", () => {
  it("uses platform config roots without reading a user's home", () => {
    expect(herdrConfigPath({ home: "/home/test", platform: "linux", env: {} })).toBe("/home/test/.config/herdr/config.toml");
    expect(herdrConfigPath({ home: "/home/test", platform: "darwin", env: { XDG_CONFIG_HOME: "/isolated/config" } })).toBe("/isolated/config/herdr/config.toml");
    expect(herdrConfigPath({ home: "/home/test", platform: "win32", env: { APPDATA: "/roaming", XDG_CONFIG_HOME: "/ignored" } })).toBe("/roaming/herdr/config.toml");
  });

  it("uses defaults only when the file is absent", async () => {
    const map = await readKeymap(config());
    expect(map.prefix).toEqual(["ctrl+b"]);
    expect(map.bindings.find((binding) => binding.action === "new_tab")?.keys).toEqual(["prefix+c"]);
  });

  it("reads fresh overrides and never exposes command bodies", async () => {
    const path = config('[keys]\nprefix = ["ctrl+shift+8"]\nnew_tab = ["prefix+t", "cmd+t"]\n[[keys.command]]\nkey = "prefix+x"\ntype = "shell"\ncommand = "secret-command-token"\ndescription = "Local action"\n');
    const response = await keybindingsResponse(new Request("http://localhost/api/keybindings"), path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const map = readHerdrKeymap(await response.json());
    expect(map.prefix).toEqual(["ctrl+shift+8"]);
    expect(map.bindings.find((binding) => binding.action === "new_tab")?.keys).toEqual(["prefix+t", "cmd+t"]);
    expect(map.commands).toEqual([{ key: "prefix+x", type: "shell", description: "Local action" }]);
    writeFileSync(path, '[keys]\nprefix = "ctrl+shift+9"\n');
    expect((await readKeymap(path)).prefix).toEqual(["ctrl+shift+9"]);
  });

  it("keeps explicit disabled and malformed values from restoring a default", () => {
    const map = mergeHerdrKeymap({ keys: { prefix: [], new_tab: "", help: [], settings: false, goto: ["prefix+g", false], unknown_action: "prefix+a" } });
    expect(map.prefix).toEqual([]);
    for (const action of ["new_tab", "help", "settings", "goto"]) expect(map.bindings.find((binding) => binding.action === action)?.keys).toEqual([]);
    expect(map.bindings.find((binding) => binding.action === "unknown_action")?.keys).toEqual(["prefix+a"]);
  });

  it("reports invalid TOML without silently installing defaults", async () => {
    const response = await keybindingsResponse(new Request("http://localhost/api/keybindings"), config('[keys\nprefix="secret-invalid-token"'));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe("keymap_unavailable");
    expect(JSON.stringify(body)).not.toContain("secret-invalid-token");
  });

  it("rejects a malformed keys table instead of silently importing defaults", async () => {
    const response = await keybindingsResponse(new Request("http://localhost/api/keybindings"), config('keys = "invalid"'));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("keymap_unavailable");
  });

  it("refuses a mutation instead of executing a configured command", async () => {
    const response = await keybindingsResponse(new Request("http://localhost/api/keybindings", { method: "POST" }), config());
    expect(response.status).toBe(405);
    expect((await response.json()).error.code).toBe("method_not_allowed");
  });

  it("allows only the PC-scoped keymap route, not command execution", () => {
    expect(MACHINE_PROXY_PATH.test("keybindings")).toBe(true);
    for (const path of ["keys/command", "keybindings/command", "keybindings/../keys/command", "keybindings/"]) {
      expect(MACHINE_PROXY_PATH.test(path)).toBe(false);
    }
  });

  it("refuses malformed remote responses before they can install bindings", () => {
    for (const body of [null, { prefix: ["ctrl+b"], bindings: [{ action: "new_tab", keys: [1] }], commands: [] },
      { prefix: ["ctrl+b"], bindings: [], commands: [{ key: "prefix+c", type: "shell", description: null }] }]) {
      expect(() => readHerdrKeymap(body)).toThrow(TypeError);
    }
  });
});
