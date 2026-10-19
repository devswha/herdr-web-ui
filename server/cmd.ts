import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { homedir } from "node:os";

import { agentGet, paneProcessInfo } from "./herdr/client.ts";
import { processEnviron } from "./omo.ts";

/**
 * Command Code's session store. One directory per project (the cwd), under
 * `~/.commandcode/projects/<slug>`, where `<slug>` is the cwd with its leading
 * slash dropped and every other slash turned into a dash, lowercased.
 */
export function cmdSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\]/g, "-").toLowerCase();
}

export function defaultCmdHome(): string {
  return join(homedir(), ".commandcode");
}

export function defaultCmdProjectDir(cwd: string): string {
  return join(defaultCmdHome(), "projects", cmdSlug(cwd));
}

/** Where the commandcode provider's cached catalog lives: the file pi reads the same models from. */
export function cmdModelCatalogPath(): string {
  return join(homedir(), ".pi", "agent", "commandcode-models.json");
}

/**
 * The canonical file inside the store, or null. Command Code names an absolute
 * path itself, so the store is checked rather than trusted: a path elsewhere, a
 * link out of it or a non-session file is no evidence.
 */
export function cmdTranscriptInStore(path: string, sessionDir: string): string | null {
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(sessionDir);
  } catch { return null; }
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  if (!canonical.endsWith(".jsonl")) return null;
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? canonical : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const absent = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "ENOENT";

export function unwrittenSession(path: string, sessionDir: string): { id: string; path: string } | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  let root: string;
  try { root = realpathSync(sessionDir); } catch { return null; }
  try {
    lstatSync(path);
    return null;
  } catch (error) { if (!absent(error)) return null; }
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      const real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return null;
      const inside = relative(root, real);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
      return { id: basename(path, ".jsonl"), path: join(real, relative(dir, path)) };
    } catch (error) {
      if (!absent(error) || dirname(dir) === dir) return null;
      try { lstatSync(dir); return null; } catch (missing) { if (!absent(missing)) return null; }
    }
  }
}

const CMD_EXECUTABLE = /(^|[\\/])command[-_]?code(?:\.exe|\.[cm]?js)?$/i;
const CMD_NPM_ENTRY = /(^|[\\/])node_modules[\\/]command-code[\\/]/i;

export function isCmdProcess(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const exec = argv[0] ?? "";
  const base = exec.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(?:exe|cmd|js|mjs|cjs)$/i, "");
  if (base === "commandcode" || base === "cmdc" || base === "command-code" || base === "cmd") {
    // only treat `cmd` as Command Code when it actually runs command-code
    if (base === "cmd") {
      return argv.some((word) => /command[-_]?code/i.test(word));
    }
    return true;
  }
  if (/(?:^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(exec) && argv.slice(1).some((word) => CMD_NPM_ENTRY.test(word) || /command[-_]?code/i.test(word))) {
    return true;
  }
  return CMD_EXECUTABLE.test(exec);
}

type CmdProcess = { pid?: number; argv?: readonly string[] | null; cwd?: string | null };
type CmdTranscriptOptions = {
  agent?: Awaited<ReturnType<typeof agentGet>> | null;
  processes?: readonly CmdProcess[];
  environOf?: (pid: number) => readonly string[] | null;
  argvOf?: (pid: number) => readonly string[] | null;
  home?: string;
};

function processArgv(pid: number): readonly string[] | null {
  if (process.platform !== "linux") return null;
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); }
  catch { return null; }
}

export async function cmdTranscriptPath(
  paneId: string,
  options: CmdTranscriptOptions = {},
): Promise<{ path: string } | { unwritten: { id: string; path: string } } | null> {
  const agent = options.agent === undefined ? await agentGet(paneId).catch(() => null) : options.agent;
  if (agent?.agent !== "cmd") return null;

  const cwd = (typeof agent.cwd === "string" && agent.cwd.length > 0 ? agent.cwd : null)
    ?? (typeof agent.foreground_cwd === "string" ? agent.foreground_cwd : null);
  if (!cwd) return null;
  const projectDir = defaultCmdProjectDir(cwd);

  // session value reported by herdr (if any)
  const session = agent.agent_session;
  const reportedPath = (session?.agent === "cmd" && session.source === "herdr:cmd" && session.kind === "path"
    && typeof session.value === "string") ? session.value : null;

  const info = options.processes === undefined
    ? await paneProcessInfo(paneId).catch(() => undefined)
    : { foreground_processes: [...options.processes] };
  const environOf = options.environOf ?? processEnviron;
  const argvOf = options.argvOf ?? processArgv;

  const cmdProcesses: { pid: number; argv: readonly string[] }[] = [];
  for (const entry of info?.foreground_processes ?? []) {
    if (typeof entry.pid !== "number") continue;
    const argv = entry.argv?.length ? entry.argv : argvOf(entry.pid);
    if (argv?.length && isCmdProcess(argv)) cmdProcesses.push({ pid: entry.pid, argv });
  }

  // session id from environ
  let sessionId: string | null = null;
  for (const process of cmdProcesses) {
    const env = environOf(process.pid);
    if (!env) continue;
    const entry = env.find((word) => word.startsWith("COMMANDCODE_SESSION_ID="));
    if (entry) { sessionId = entry.slice("COMMANDCODE_SESSION_ID=".length); break; }
  }

  // candidate path
  let candidate: string | null = reportedPath;
  if (candidate === null && sessionId) candidate = join(projectDir, `${sessionId}.jsonl`);

  if (candidate === null) return null;
  const path = cmdTranscriptInStore(candidate, projectDir);
  if (path !== null) return { path };
  const unwritten = unwrittenSession(candidate, projectDir);
  return unwritten === null ? null : { unwritten };
}

/**
 * Command Code's context window for a model: read from the commandcode provider's
 * cached catalog. On `main` pi-models only consults models.json, which never
 * names commandcode's models, so cmd resolves its own window here.
 */
let cmdCatalogCache: { path: string; mtimeMs: number; windows: Map<string, number> } | null = null;

export function cmdContextWindow(model: string, catalogPath = cmdModelCatalogPath()): number | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(catalogPath).mtimeMs; } catch { return null; }
  if (cmdCatalogCache === null || cmdCatalogCache.path !== catalogPath || cmdCatalogCache.mtimeMs !== mtimeMs) {
    let text: string;
    try { text = readFileSync(catalogPath, "utf8"); } catch { return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
    const windows = new Map<string, number>();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as { models?: unknown };
      if (Array.isArray(record.models)) {
        for (const value of record.models) {
          if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
          const entry = value as { id?: unknown; contextWindow?: unknown };
          if (typeof entry.id !== "string") continue;
          const window = entry.contextWindow;
          if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
          windows.set(entry.id, window);
        }
      }
    }
    cmdCatalogCache = { path: catalogPath, mtimeMs, windows };
  }
  return cmdCatalogCache.windows.get(model) ?? null;
}