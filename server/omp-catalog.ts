/**
 * The models a pane's omp can run, from `omp models --json`, for reading the model omp's status
 * line names (start-screen.ts). omp draws the model there by catalog name, not id, and writes no
 * session file until its first answer, so before then the catalog is what ties the name to an id.
 */
import { paneProcessInfo } from "./herdr/client.ts";
import { isJsonObject } from "./http.ts";
import { processEnviron } from "./omo.ts";
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
const catalogs = new Map<string, { at: number; models: Promise<OmpCatalogModel[]> }>();

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
    if (word === "--profile") profile = argv[at + 1] ?? null;
    else if (word.startsWith("--profile=")) profile = word.slice(10);
  }
  if (profile !== null && !/^[\w.-]+$/.test(profile)) return null;
  return [...executable, ...(profile === null ? [] : ["--profile", profile]), "models", "--json", "--no-extensions"];
}

async function listCatalog(command: string[], cwd: string): Promise<OmpCatalogModel[]> {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: LIST_TIMEOUT_MS, killSignal: "SIGKILL" });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("omp models failed");
  return parseOmpCatalog(text);
}

/** The catalog of the omp running in a pane, empty when it cannot be listed. */
export async function paneOmpCatalog(paneId: string, cwd: string): Promise<OmpCatalogModel[]> {
  const info = await paneProcessInfo(paneId).catch(() => undefined);
  const commands = (info?.foreground_processes ?? []).flatMap((process) => {
    const argv = Array.isArray(process.argv) ? process.argv.map(String) : [];
    const command = typeof process.pid === "number" ? ompCatalogCommand(argv, processEnviron(process.pid)) : null;
    return command === null ? [] : [command];
  });
  if (commands.length !== 1) return [];
  const command = commands[0]!;
  const key = `${cwd}\0${command.join("\0")}`;
  const now = Date.now();
  const cached = catalogs.get(key);
  if (cached !== undefined && now - cached.at < CATALOG_TTL_MS) return cached.models;
  // every reader of a listing still running shares this promise, so a failure is empty for all of
  // them; a failed listing is not kept: the next read asks again
  const models: Promise<OmpCatalogModel[]> = listCatalog(command, cwd).catch(() => {
    if (catalogs.get(key)?.models === models) catalogs.delete(key);
    return [];
  });
  catalogs.delete(key);
  catalogs.set(key, { at: now, models });
  if (catalogs.size > CATALOG_ENTRIES) catalogs.delete(catalogs.keys().next().value!);
  return models;
}

/** For tests: forget every listing. */
export function forgetOmpCatalogs(): void {
  catalogs.clear();
}
