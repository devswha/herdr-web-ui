/**
 * The models a pane's omp can run, from `omp models --json`, for reading the model omp's status
 * line names (start-screen.ts). omp draws the model there by catalog name, not id, and writes no
 * session file until its first answer, so before then the catalog is what ties the name to an id.
 */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { paneProcessInfo } from "./herdr/client.ts";
import { isJsonObject } from "./http.ts";
import { ompProcessMemory } from "./omp-process.ts";
import { isOmpProcess } from "./omp.ts";

/** One catalog row: the id omp's transcript records, and the name its status line draws. */
export interface OmpCatalogModel {
  id: string;
  name: string;
}

const LIST_TIMEOUT_MS = 10_000;
/** A conversation not begun is read on every burst of terminal output: one listing serves a minute. */
const CATALOG_TTL_MS = 60_000;
const CATALOG_ENTRIES = 16;
const catalogs = new Map<string, { at: number; models: OmpCatalogModel[] }>();
const pending = new Map<string, Promise<OmpCatalogModel[]>>();
const MAX_LISTINGS = 16;
let liveListings = 0;

/** The id and name of each row; a listing in any other shape names nothing. */
export function parseOmpCatalog(text: string): OmpCatalogModel[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  if (!isJsonObject(data) || !Array.isArray(data["models"])) return [];
  const models: OmpCatalogModel[] = [];
  for (const row of data["models"]) {
    if (!isJsonObject(row) || typeof row["id"] !== "string" || row["id"] === "") continue;
    // omp's status line falls back to the id where a model has no name
    const name = typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : row["id"];
    models.push({ id: row["id"], name });
  }
  return models;
}

/**
 * The command that lists the catalog of the omp a pane runs: the same executable (`omp`, or the
 * runtime and script that run it) and profile, never its extensions, which listing must not run.
 * null unless exactly one omp is in the pane's foreground.
 */
export function ompCatalogCommand(argv: readonly string[], environ: readonly string[] | null): string[] | null {
  if (!isOmpProcess(argv)) return null;
  const executable = argv.slice(0, isOmpProcess(argv.slice(0, 1)) ? 1 : 2);
  let profile = environ?.find((word) => word.startsWith("OMP_PROFILE="))?.slice(12) || null;
  for (let at = executable.length; at < argv.length; at++) {
    const word = argv[at]!;
    if (word === "--") break;
    // Explicit overlays/extensions cannot safely be listed; their names may shadow built-ins.
    if (word === "--config" || word.startsWith("--config=") || word.startsWith("-e") || word === "--extension" || word.startsWith("--extension=")) return null;
    if (word === "--profile") profile = argv[++at] ?? "";
    else if (word.startsWith("--profile=")) profile = word.slice(10);
  }
  if (profile !== null && (!/^[\w.-]+$/.test(profile) || profile === "." || profile === "..")) return null;
  return [...executable, ...(profile === null ? [] : ["--profile", profile]), "models", "--json", "--no-extensions"];
}

/** A listing's deadline covers stdout too, even when the direct child has already exited. */
export async function listOmpCatalog(command: string[], env: Record<string, string>, timeoutMs = LIST_TIMEOUT_MS): Promise<OmpCatalogModel[]> {
  // Neither Bun's startup configuration nor omp's project discovery may enter the pane's project.
  const cwd = await mkdtemp(join(tmpdir(), "herdr-omp-models-"));
  try {
    const bun = /(?:^|[\\/])bun(?:\.exe)?$/i.test(command[0]!);
    if (bun) {
      const config = join(cwd, "bunfig.toml");
      await writeFile(config, "");
      command = [command[0]!, `--config=${config}`, ...command.slice(1)];
    }
    const child = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    liveListings++;
    void child.exited.finally(() => { liveListings--; });
    const reader = child.stdout.getReader();
    return await new Promise<OmpCatalogModel[]>((resolve) => {
      let finished = false;
      const finish = (models: OmpCatalogModel[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        // A descendant may keep the pipe open after its parent exits. Do not await cancellation.
        void reader.cancel().catch(() => {});
        resolve(models);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      void (async () => {
        try {
          const decoder = new TextDecoder();
          let text = "", bytes = 0;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 1024 * 1024) { finish([]); return; }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          finish(await child.exited === 0 ? parseOmpCatalog(text) : []);
        } catch { finish([]); }
      })();
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

/** The catalog of the omp running in a pane, empty when it cannot be listed. */
export async function paneOmpCatalog(paneId: string, cwd: string, waitMs?: number): Promise<OmpCatalogModel[]> {
  const info = await paneProcessInfo(paneId).catch(() => undefined);
  const commands: { command: string[]; env: Record<string, string> }[] = [];
  for (const foreground of info?.foreground_processes ?? []) {
    if (typeof foreground.pid !== "number") continue;
    let argv = Array.isArray(foreground.argv) ? foreground.argv.map(String) : [];
    if (argv.length > 0 && !isOmpProcess(argv)) continue;
    // Also recover argv that herdr deliberately omits on WSL. Never read environ on this loop.
    const memory = await ompProcessMemory(foreground.pid, true);
    if (memory === null) continue;
    argv = memory.argv;
    const command = ompCatalogCommand(argv, memory.environ);
    if (command === null) continue;
    const executable = isAbsolute(command[0]!) ? command[0]! : memory.executable;
    if (executable === undefined) continue;
    if (!isAbsolute(executable) || !(await stat(executable).catch(() => null))?.isFile()) continue;
    command[0] = executable;
    if (command.length > 4 && !isOmpProcess(command.slice(0, 1))) {
      const script = command[1]!;
      if (!isAbsolute(script) || !(await stat(script).catch(() => null))?.isFile()) continue;
    }
    const env = Object.fromEntries(memory.environ.filter((word) => /^(?:PATH|OMP_PROFILE|HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)=/.test(word)).map((word) => {
      const at = word.indexOf("=");
      return [word.slice(0, at), word.slice(at + 1)];
    }));
    // A missing environment must never silently select the server's home or executable path.
    if (!env["HOME"] || !env["PATH"]) continue;
    commands.push({ command, env });
  }
  if (commands.length !== 1) return [];
  const { command, env } = commands[0]!;
  const key = `${cwd}\0${command.join("\0")}\0${JSON.stringify(env)}`;
  const now = Date.now();
  const cached = catalogs.get(key);
  if (cached !== undefined && now - cached.at < CATALOG_TTL_MS) return cached.models;
  let models = pending.get(key);
  if (models === undefined) {
    // Running requests are not TTL/size-evicted, and have their own admission bound.
    if (pending.size >= MAX_LISTINGS || liveListings >= MAX_LISTINGS) return [];
    models = listOmpCatalog(command, env).catch(() => []).then((models) => {
      if (models.length > 0) {
        catalogs.delete(key);
        catalogs.set(key, { at: Date.now(), models });
        if (catalogs.size > CATALOG_ENTRIES) catalogs.delete(catalogs.keys().next().value!);
      }
      return models;
    }).finally(() => { pending.delete(key); });
    pending.set(key, models);
  }
  if (waitMs === undefined) return models;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([models, new Promise<OmpCatalogModel[]>((resolve) => { timer = setTimeout(() => resolve([]), waitMs); })]);
  } finally { clearTimeout(timer); }
}

/** For tests: forget every listing. */
export function forgetOmpCatalogs(): void {
  catalogs.clear();
}
