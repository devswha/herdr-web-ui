/**
 * OMP sessions from the pane's own process when Herdr supplies no usable session path.
 * Herdr deliberately omits recognized agents' argv on WSL to avoid blocking procfs reads.
 * Recover process identity outside the bridge, then use the open transcript or breadcrumb.
 */
import { isAbsolute, join, resolve } from "node:path";

import { paneProcessInfo } from "./herdr/client.ts";
import { heldTranscript, runsAgent } from "./gjc-runtime.ts";
import { processEnviron } from "./omo.ts";
import { isWsl, ompProcessCwd, ompProcessMemory, processStartTicks } from "./omp-process.ts";

const OMP_EXECUTABLE = /(^|[\\/])omp(?:\.exe|\.[cm]?js)?$/i;

export function isOmpProcess(argv: readonly string[]): boolean {
  return runsAgent(argv, OMP_EXECUTABLE);
}

/** omp's options that take the next word as their value, even one that looks like an option. */
const VALUE_OPTIONS = new Set([
  "--cwd", "--profile", "--alias", "--session-dir", "--config", "--add-dir", "--mode", "--fork", "--provider", "--model",
  "--smol", "--slow", "--goal", "--prewalk-into", "--plan-yolo-into", "--max-time", "--service-tier", "--api-key",
  "--system-prompt", "--system-prompt-template", "--append-system-prompt", "--provider-session-id", "--prompt-cache-key",
  "--models", "--tools", "--thinking", "--export", "--hook", "--extension", "-e", "--trusted-extension", "--plugin-dir",
  "--skills", "--approval-mode",
]);
/** Options that take the next word only when it does not look like an option. */
const OPTIONAL_VALUE_OPTIONS = new Set(["--plan", "--resume", "-r", "--session"]);

/** What an omp command line says about where it keeps its session: the last of each option wins. */
export interface OmpLaunch { profile: string | null; sessionDir: boolean; cwd: string | null }

/**
 * The store options of omp's own argv (as the process has it, never a shell string), read the way
 * omp reads them: up to `--`, an option's value consumed with it, the last one winning. null when
 * `--cwd` or `--profile` comes without a value: nothing then says where the session is.
 */
export function ompLaunch(argv: readonly string[]): OmpLaunch | null {
  const launch: OmpLaunch = { profile: null, sessionDir: false, cwd: null };
  // a bun or node interpreter comes first, then omp's script
  for (let at = OMP_EXECUTABLE.test(argv[0] ?? "") ? 1 : 2; at < argv.length; at++) {
    let word = argv[at]!;
    let value: string | undefined;
    if (word === "--") break;
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals > 0) { value = word.slice(equals + 1); word = word.slice(0, equals); }
    else if (VALUE_OPTIONS.has(word)) value = argv[++at];
    else if (OPTIONAL_VALUE_OPTIONS.has(word) && argv[at + 1] && !argv[at + 1]!.startsWith("-")) at++;
    if (word === "--session-dir") launch.sessionDir = true;
    else if (word === "--cwd" || word === "--profile") {
      if (!value) return null;
      if (word === "--cwd") launch.cwd = value; else launch.profile = value;
    }
  }
  return launch;
}

/**
 * The agent directory one omp process keeps its sessions and terminal breadcrumbs in:
 * ~/.omp/agent, or ~/.omp/profiles/<name>/agent under `--profile <name>` or OMP_PROFILE (the flag
 * wins). null when `--session-dir` moved its sessions anywhere at all, the profile name could
 * leave ~/.omp/profiles, or its argv cannot be read the way omp reads it.
 */
export function ompAgentDir(argv: readonly string[], environ: readonly string[] | null, home: string): string | null {
  const launch = ompLaunch(argv);
  if (launch === null || launch.sessionDir) return null;
  const profile = launch.profile ?? (environ?.find((word) => word.startsWith("OMP_PROFILE="))?.slice(12) || null);
  if (profile === null) return join(home, ".omp", "agent");
  return /^[\w.-]+$/.test(profile) && profile !== "." && profile !== ".." ? join(home, ".omp", "profiles", profile, "agent") : null;
}

/**
 * Whether a relative `--cwd` is resolved at all. omp 18.8.7 resolves it against the directory it
 * starts in and then changes into the result (scripts/omp-relative-cwd-probe.ts), so its process
 * directory is no proof of the base once it runs: such a value finds no transcript.
 */
export const OMP_RELATIVE_CWD = false;

export interface OmpHeldOptions {
  home?: string;
  /**
   * herdr's foreground cwd for the pane. It is the omp process's own directory only when herdr
   * names that process the pane's foreground process and no other omp runs there.
   */
  foregroundCwd?: string | null;
  /** Resolve a relative `--cwd` against the omp process's proven directory (OMP_RELATIVE_CWD). */
  relativeCwd?: boolean;
}

/**
 * The transcript the pane's omp process holds open or last pointed its terminal breadcrumb at, or
 * null. `cwd` is the session directory of a process started without `--cwd`; one started with it
 * keeps its session under its last `--cwd`, never under the pane's or the shell's directory.
 */
export async function ompHeldTranscript(paneId: string, cwd: string, { home = process.env["HOME"] ?? "", foregroundCwd = null, relativeCwd = OMP_RELATIVE_CWD }: OmpHeldOptions = {}): Promise<string | null> {
  const info = await paneProcessInfo(paneId).catch(() => null);
  const omps: { pid: number; agentDir: string; cwd: string | null }[] = [];
  const environs = new Map<number, readonly string[]>();
  for (const foreground of info?.foreground_processes ?? []) {
    if (typeof foreground.pid !== "number") continue;
    let argv = Array.isArray(foreground.argv) ? foreground.argv.map(String) : [];
    if (argv.length > 0 && !isOmpProcess(argv)) continue;
    // Herdr omits a recognized agent's argv on WSL; there, and only there, procfs memory reads
    // may block, so they go through the helper. Elsewhere herdr's argv and a direct read hold.
    const probe = process.platform === "linux" && (argv.length === 0 || isWsl());
    let environ: readonly string[] | undefined;
    if (probe) {
      const memory = await ompProcessMemory(foreground.pid, argv.length === 0);
      if (memory === null) continue;
      if (argv.length === 0) argv = memory.argv;
      environ = memory.environ;
    }
    if (!isOmpProcess(argv)) continue;
    const agentDir = ompAgentDir(argv, environ ?? processEnviron(foreground.pid), home);
    // a moved store or an unreadable command line: nothing says which session the pane shows
    if (agentDir === null) return null;
    omps.push({ pid: foreground.pid, agentDir, cwd: ompLaunch(argv)!.cwd });
    if (environ !== undefined) environs.set(foreground.pid, environ);
  }
  if (omps.length === 0) return null;
  /** Processes whose directory came from herdr, by the start time they had then. */
  const starts = new Map<number, string>();
  let route: { agentDir: string; cwd: string } | null = null;
  for (const omp of omps) {
    let effective: string | null;
    if (omp.cwd === null) effective = cwd;
    else if (isAbsolute(omp.cwd)) effective = resolve(omp.cwd);
    else if (!relativeCwd || process.platform === "win32") effective = null;
    else {
      let base: string | null = null;
      const start = processStartTicks(omp.pid);
      if (omps.length === 1 && info?.foreground_process_group_id === omp.pid && start !== null && typeof foregroundCwd === "string" && isAbsolute(foregroundCwd)) {
        base = foregroundCwd;
        starts.set(omp.pid, start);
      }
      base ??= await ompProcessCwd(omp.pid);
      effective = base === null ? null : resolve(base, omp.cwd);
    }
    // two omp processes keeping different stores or directories: nothing says which the pane shows
    if (effective === null || route !== null && (route.agentDir !== omp.agentDir || route.cwd !== effective)) return null;
    route = { agentDir: omp.agentDir, cwd: effective };
  }
  // a probed process's environment stands in for gjcTerminal's /proc read, which could block too
  const path = heldTranscript(route!.agentDir, route!.cwd, omps.map((omp) => omp.pid), (pid) => environs.get(pid)).path;
  // herdr's directory was this process's own only if the pid still names the same process
  for (const [pid, start] of starts) if (processStartTicks(pid) !== start) return null;
  return path;
}
