import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeHerdrKeymap, type HerdrKeymap } from "../shared/herdr-keymap.ts";
import { jsonResponse } from "./http.ts";

/** Same platform config root as remote-entry.ts. Never accept a path from the HTTP request. */
export function herdrConfigPath(options: { home: string; platform: string; env: NodeJS.ProcessEnv }): string {
  const base = options.platform === "win32"
    ? options.env["APPDATA"] || join(options.home, "AppData", "Roaming")
    : options.env["XDG_CONFIG_HOME"] || join(options.home, ".config");
  return join(base, "herdr", "config.toml");
}

export async function readKeymap(path: string): Promise<HerdrKeymap> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return mergeHerdrKeymap(undefined);
    throw error;
  }
  return mergeHerdrKeymap(Bun.TOML.parse(text));
}

export async function keybindingsResponse(request: Request, path = herdrConfigPath({ home: homedir(), platform: process.platform, env: process.env })): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "use GET" } }, 405);
  try { return jsonResponse(await readKeymap(path), 200, { "cache-control": "no-store" }); }
  catch {
    // Do not leak file contents, command bodies or host paths in parser/I/O errors.
    return jsonResponse({ error: { code: "keymap_unavailable", message: "Could not read Herdr key bindings. Check config.toml on the selected PC." } }, 422);
  }
}
