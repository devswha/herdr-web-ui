/**
 * Whether the installed omp keeps the directory it was started in as its process directory when
 * given a relative `--cwd`: only then can that directory be the base the bridge resolves the
 * value against (server/omp.ts OMP_RELATIVE_CWD). Starts omp twice in a temporary HOME, from A
 * with `--cwd rel` and from a wrapper that changes to X before exec, reads each process's
 * directory through the bridge's own bounded probe and compares it with the session directory omp
 * picked. No prompt is sent, and provider and update traffic goes to a closed local port.
 *
 *   bun scripts/omp-relative-cwd-probe.ts
 *
 * Exits 1 when the result disagrees with OMP_RELATIVE_CWD, 0 otherwise (also when omp is absent).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OMP_RELATIVE_CWD, ompLaunch } from "../server/omp.ts";
import { ompProcessCwd, ompProcessMemory } from "../server/omp-process.ts";

const STARTUP_MS = 30_000;
const omp = Bun.which("omp");
const home = realpathSync(mkdtempSync(join(tmpdir(), "omp-relative-cwd-")));
const closed = "http://127.0.0.1:9";
const env = {
  HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8",
  HTTP_PROXY: closed, HTTPS_PROXY: closed, http_proxy: closed, https_proxy: closed, NO_PROXY: "", OLLAMA_BASE_URL: closed, PI_NO_TITLE: "1",
};
const agentDir = join(home, ".omp", "agent");

type Launch = { name: string; base: string; expected: string; processCwd: string | null; argv: string[] | null; sessions: string[]; breadcrumbCwd: string | null; pid: number; gone: boolean };

/** The breadcrumb cwd omp wrote for its terminal, once it has. */
function breadcrumbCwd(): string | null {
  try {
    for (const name of readdirSync(join(agentDir, "terminal-sessions"))) {
      const cwd = readFileSync(join(agentDir, "terminal-sessions", name), "utf8").split("\n")[0];
      if (cwd) return cwd;
    }
  } catch { /* not written yet */ }
  return null;
}

async function launch(name: string, base: string, wrapperCd: string | null): Promise<Launch> {
  rmSync(agentDir, { recursive: true, force: true });
  const command = wrapperCd === null ? [omp!, "--cwd", "rel"] : ["sh", "-c", 'cd "$1" && exec "$2" --cwd rel', "sh", wrapperCd, omp!];
  let output = "";
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  // subscribed before the spawn: every chunk rechecks whether omp has settled its session
  const child = Bun.spawn(command, {
    cwd: base, env,
    terminal: { cols: 120, rows: 40, data(_terminal, data) { output += new TextDecoder().decode(data); if (output.length > 0 && breadcrumbCwd() !== null) started(); } },
  });
  try {
    const outcome = await Promise.race([
      ready.then(() => "ready"),
      child.exited.then((code) => `exited ${code}`),
      new Promise<string>((resolve) => { const timer = setTimeout(() => resolve("startup deadline"), STARTUP_MS); void child.exited.finally(() => clearTimeout(timer)); }),
    ]);
    if (outcome !== "ready") throw new Error(`${name}: omp did not start (${outcome}): ${Bun.stripANSI(output).slice(-400)}`);
    const memory = await ompProcessMemory(child.pid, true);
    const processCwd = await ompProcessCwd(child.pid);
    const sessions = existsSync(join(agentDir, "sessions")) ? readdirSync(join(agentDir, "sessions")) : [];
    return { name, base: wrapperCd ?? base, expected: join(wrapperCd ?? base, "rel"), processCwd, argv: memory?.argv ?? null, sessions, breadcrumbCwd: breadcrumbCwd(), pid: child.pid, gone: false };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

let exit = 0;
const results: Launch[] = [];
try {
  if (!omp) {
    console.log("omp: not installed");
    console.log("relative --cwd: unavailable (omp is not installed, so nothing proves its process directory)");
  } else {
    const version = Bun.spawnSync([omp, "--version"], { env, stdout: "pipe", stderr: "pipe" });
    console.log(`omp --version: ${version.stdout.toString().trim() || version.stderr.toString().trim()} (exit ${version.exitCode})`);
    const a = join(home, "A"), x = join(home, "X");
    for (const dir of [a, x]) mkdirSync(join(dir, "rel"), { recursive: true });
    results.push(await launch("direct", a, null));
    results.push(await launch("wrapper", a, x));
    let proven = true;
    for (const result of results) {
      const options = result.argv && ompLaunch(result.argv);
      const sessionDir = result.expected.replaceAll("/", "-");
      console.log(`${result.name}: pid ${result.pid}, argv ${JSON.stringify(result.argv)}, parsed --cwd ${JSON.stringify(options ? options.cwd : null)}`);
      console.log(`${result.name}: started in ${result.base}; process cwd ${result.processCwd ?? "unreadable"}; breadcrumb cwd ${result.breadcrumbCwd}; sessions ${JSON.stringify(result.sessions)}`);
      const settled = result.breadcrumbCwd === result.expected && result.sessions.includes(sessionDir);
      const unchanged = result.processCwd === result.base;
      console.log(`${result.name}: session under ${result.expected}: ${settled ? "yes" : "no"}; process cwd stayed ${result.base}: ${unchanged ? "yes" : result.processCwd === null ? "unreadable" : `no, it is ${result.processCwd}`}`);
      if (options?.cwd !== "rel") { console.log(`${result.name}: omp's argv does not parse to --cwd rel`); exit = 1; }
      if (!settled) { console.log(`${result.name}: omp did not keep its session under ${result.expected}`); exit = 1; }
      proven &&= settled && unchanged;
    }
    console.log(proven
      ? "relative --cwd: proven (omp keeps its start directory, the base of a relative --cwd)"
      : "relative --cwd: unavailable (omp changes its process cwd into the --cwd value or it is unreadable, so its directory proves no base)");
    if (proven !== OMP_RELATIVE_CWD) {
      console.log(`OMP_RELATIVE_CWD is ${OMP_RELATIVE_CWD}, but this omp says ${proven}: update server/omp.ts`);
      exit = 1;
    } else console.log(`OMP_RELATIVE_CWD is ${OMP_RELATIVE_CWD}: consistent with this omp`);
  }
} finally {
  for (const result of results) {
    try { process.kill(result.pid, 0); } catch { result.gone = true; }
    console.log(`cleanup: pid ${result.pid} ${result.gone ? "gone (kill -0 fails)" : "STILL RUNNING"}`);
    if (!result.gone) exit = 1;
  }
  rmSync(home, { recursive: true, force: true });
  console.log(`cleanup: ${home} ${existsSync(home) ? "STILL PRESENT" : "removed"}`);
}
process.exit(exit);
