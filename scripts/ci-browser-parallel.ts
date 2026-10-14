/**
 * Parallel browser lane: runs browser regression scripts concurrently with a worker pool.
 * Workers are isolated by temp dir and evidence subdirectory. The demo build is shared read-only.
 * The script list is read from scripts/ci-browser.sh, the serial lane, so the two cannot drift.
 * Every script's full output goes to <CHECK_DIR or .ci>/browser-logs/<script>.log.
 *
 * BROWSER_WORKERS: worker count (default: min(cores/2, 6))
 * BROWSER_SCRIPTS: comma-separated list of scripts to run (default: all from ci-browser.sh)
 * BROWSER_EXCLUDE: comma-separated list of scripts to leave out of that list
 * BROWSER_RETRY: 0 runs a failed script once only (default: a failed script runs a second time)
 *
 * A script that fails and then passes is reported as flaky, not hidden: its first log is kept as
 * <script>.attempt-1.log and printed, summary.json lists it, and under GitHub Actions it gets a
 * warning annotation and a line in the job summary. A script that fails twice fails the lane.
 */
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repo = join(import.meta.dir, "..");
const FAILURE_TAIL_LINES = 400;
const HEARTBEAT_MS = 60_000;

/** The scripts the serial lane runs, in its order (the demo build, which takes an argument, is not one). */
export function serialBrowserScripts(source = readFileSync(join(repo, "scripts/ci-browser.sh"), "utf8")): string[] {
  return [...source.matchAll(/^run_script (scripts\/[\w.-]+\.ts)\s*$/gm)].map((match) => match[1]!);
}

const list = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Applies BROWSER_SCRIPTS and BROWSER_EXCLUDE to the serial list; a name it does not hold is an error. */
export function selectBrowserScripts(all: string[], include?: string, exclude?: string): string[] {
  const included = include?.trim() ? list(include) : all;
  const excluded = list(exclude);
  const unknown = [...included, ...excluded].filter((script) => !all.includes(script));
  if (unknown.length > 0) throw new Error(`Not in scripts/ci-browser.sh: ${[...new Set(unknown)].join(", ")}`);
  return [...new Set(included)].filter((script) => !excluded.includes(script));
}

interface ScriptResult {
  script: string;
  seconds: number;
  code: number;
  log: string;
  /** the log of the run that failed before this one passed or failed again */
  firstLog?: string;
}

/** How a script ended, from its last exit code and whether that was its second run: a pass after a failure is flaky, never a plain pass. */
export function scriptOutcome(code: number, secondRun: boolean): "pass" | "flaky" | "fail" {
  if (code !== 0) return "fail";
  return secondRun ? "flaky" : "pass";
}

class ChromiumSetupError extends Error {
  constructor(readonly exitCode: number) {
    super(`Chromium setup failed with exit code ${exitCode}`);
  }
}

function installChromium(): string {
  const setup = Bun.spawnSync(["bash", "scripts/ci-chromium.sh"], {
    cwd: repo,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (setup.exitCode !== 0) throw new ChromiumSetupError(setup.exitCode ?? 1);
  const path = setup.stdout.toString().replace(/\r?\n$/, "");
  if (!path || path.includes("\n")) throw new Error("Chromium setup returned an invalid executable path");
  return path;
}

async function buildDemo(dir: string): Promise<void> {
  console.log("[setup] Building demo app...");
  const started = Date.now();
  const child = Bun.spawn(["bun", "scripts/demo-build.ts", dir], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Demo build failed:\n${stdout}\n${stderr}`);
  console.log(`[setup] Demo build completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runScript(script: string, env: Record<string, string>, log: string): Promise<ScriptResult> {
  const started = Date.now();
  const fd = openSync(log, "w");
  try {
    const child = Bun.spawn(["bun", script], {
      cwd: repo,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    // A hung script shows up as a repeated line instead of silence.
    const heartbeat = setInterval(() => {
      console.log(`[running] ${script} (${Math.round((Date.now() - started) / 1000)}s, log ${log})`);
    }, HEARTBEAT_MS);
    const code = await child.exited.finally(() => clearInterval(heartbeat));
    return { script, seconds: (Date.now() - started) / 1000, code, log };
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const scripts = selectBrowserScripts(serialBrowserScripts(), process.env.BROWSER_SCRIPTS, process.env.BROWSER_EXCLUDE);
  if (scripts.length === 0) throw new Error("No browser scripts selected");

  const requested = Number(process.env.BROWSER_WORKERS);
  const workers = Math.max(1, Math.min(
    requested >= 1 ? Math.floor(requested) : Math.min(Math.floor(availableParallelism() / 2), 6),
    scripts.length
  ));
  const logDir = join(process.env.CHECK_DIR || ".ci", "browser-logs");
  mkdirSync(logDir, { recursive: true });

  console.log(`Browser lane: ${scripts.length} scripts, ${workers} workers, logs in ${logDir}`);

  const chromePath = installChromium();
  const demoBuild = mkdtempSync(join(tmpdir(), "herdr-demo-parallel-"));
  await buildDemo(demoBuild);

  const checkDir = process.env.CHECK_DIR;
  const baseEvidenceDir = checkDir ? join(checkDir, "browser-evidence") : process.env.CI ? ".ci/browser-evidence" : undefined;
  if (baseEvidenceDir) mkdirSync(baseEvidenceDir, { recursive: true });

  const retry = process.env.BROWSER_RETRY !== "0";
  const queue = [...scripts];
  const results: ScriptResult[] = [];
  const lock = { active: 0 };

  async function work(workerId: number): Promise<void> {
    while (queue.length > 0) {
      const script = queue.shift();
      if (!script) break;
      lock.active++;
      const scriptName = basename(script, ".ts");
      const evidenceDir = baseEvidenceDir ? join(baseEvidenceDir, scriptName) : undefined;
      if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

      const shouldDisableEvidence = baseEvidenceDir && (
        script === "scripts/ui-regression.ts" ||
        script === "scripts/ui-contexts-regression.ts" ||
        script === "scripts/key-bar-customization-demo-regression.ts"
      );

      const log = join(logDir, `${scriptName}.log`);
      const env = {
        CHROME_PATH: chromePath,
        HERDR_DEMO_BUILD: demoBuild,
        UI_EVIDENCE_DIR: shouldDisableEvidence ? "" : (evidenceDir ?? ""),
        CHECK_BROWSER_EVIDENCE_DIR: evidenceDir ?? "",
      };
      console.log(`[worker-${workerId}] START ${script}`);
      let result = await runScript(script, env, log);
      if (result.code !== 0 && retry) {
        const firstLog = join(logDir, `${scriptName}.attempt-1.log`);
        renameSync(log, firstLog);
        console.log(`[worker-${workerId}] FAIL ${script} (${result.seconds.toFixed(1)}s) exit=${result.code}, log ${firstLog}; running it once more`);
        const second = await runScript(script, env, log);
        result = { ...second, seconds: result.seconds + second.seconds, firstLog };
      }
      results.push(result);
      const outcome = scriptOutcome(result.code, result.firstLog !== undefined);
      const failure = outcome === "fail" ? ` exit=${result.code}, log ${log}` : outcome === "flaky" ? `, failed once: ${result.firstLog}` : "";
      console.log(`[worker-${workerId}] ${outcome.toUpperCase()} ${script} (${result.seconds.toFixed(1)}s)${failure}`);
      lock.active--;
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => work(i)));

  rmSync(demoBuild, { recursive: true, force: true });

  console.log("\n" + "=".repeat(80));
  console.log("Browser script summary");
  console.log("=".repeat(80));
  console.log(String.prototype.padEnd.call("script", 60) + String.prototype.padStart.call("seconds", 8) + String.prototype.padStart.call("exit", 6));
  console.log("-".repeat(80));

  const ordered = scripts.map((s) => results.find((r) => r.script === s)!).filter(Boolean);
  for (const result of ordered) {
    const status = { pass: " ", flaky: "~", fail: "!" }[scriptOutcome(result.code, result.firstLog !== undefined)];
    console.log(`${status}${result.script.padEnd(59)}${result.seconds.toFixed(1).padStart(8)}${String(result.code).padStart(6)}`);
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);
  const flaky = ordered.filter((r) => scriptOutcome(r.code, r.firstLog !== undefined) === "flaky");

  console.log("-".repeat(80));
  console.log(`Total: ${passed}/${results.length} passed in ${totalSeconds.toFixed(1)}s with ${workers} workers${flaky.length > 0 ? `, ${flaky.length} only on a second run (~)` : ""}`);

  writeFileSync(join(logDir, "summary.json"), JSON.stringify({
    workers,
    seconds: totalSeconds,
    passed,
    total: results.length,
    flaky: flaky.map((r) => r.script),
    scripts: ordered.map(({ script, seconds, code, log, firstLog }) => ({ script, seconds, code, log, ...(firstLog ? { firstLog } : {}) })),
  }, null, 2) + "\n");

  const tail = (path: string): void => {
    const lines = readFileSync(path, "utf8").split("\n");
    const shown = lines.slice(-FAILURE_TAIL_LINES);
    if (shown.length < lines.length) console.log(`(last ${shown.length} of ${lines.length} lines)`);
    console.log("=".repeat(80));
    console.log(shown.join("\n"));
  };

  // A pass on the second run is still a failure somebody has to read: say so where a green job is looked at.
  for (const result of flaky) {
    console.log(`\n${"=".repeat(80)}\nFLAKY ${result.script}: failed, then passed when run again; first log: ${result.firstLog}`);
    tail(result.firstLog!);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Flaky browser script::${result.script} failed once and passed when run again. Its first log is ${basename(result.firstLog!)} in the browser-logs artifact.`);
  }
  if (flaky.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Flaky browser scripts\n\nFailed once, passed when run again:\n\n${flaky.map((r) => `- \`${r.script}\` (first log \`${basename(r.firstLog!)}\`)`).join("\n")}\n`);
  }

  for (const result of failed) {
    console.log(`\n${"=".repeat(80)}\nFAILED ${result.script} (exit ${result.code}${result.firstLog ? ", twice" : ""}), full log: ${result.log}`);
    tail(result.log);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(error instanceof ChromiumSetupError ? error.exitCode : 1);
  });
}
