/**
 * Parallel browser lane: runs browser regression scripts concurrently with a worker pool.
 * Workers are isolated by temp dir and evidence subdirectory. The demo build is shared read-only.
 *
 * BROWSER_WORKERS: worker count (default: min(cores/2, 6))
 * BROWSER_SCRIPTS: comma-separated list of scripts to run (default: all from ci-browser.sh)
 */
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ALL_SCRIPTS = [
  "scripts/ui-regression.ts",
  "scripts/workspace-rows-regression.ts",
  "scripts/pending-pane-switch-regression.ts",
  "scripts/terminal-dispose-browser-qa.ts",
  "scripts/sticky-modifiers-regression.ts",
  "scripts/terminal-arrows-clicks-regression.ts",
  "scripts/terminal-viewport-regression.ts",
  "scripts/key-bar-customization-demo-regression.ts",
  "scripts/key-bar-hold-repeat-regression.ts",
  "scripts/settings-pages-demo-regression.ts",
  "scripts/deep-link-demo-regression.ts",
  "scripts/chat-history-browser-qa.ts",
  "scripts/math-browser-qa.ts",
  "scripts/file-viewer-regression.ts",
  "scripts/keyboard-viewport-regression.ts",
  "scripts/file-viewer-mobile-regression.ts",
  "scripts/droplet-demo-regression.ts",
  "scripts/chat-greeting-demo-regression.ts",
  "scripts/restored-draft-demo-regression.ts",
  "scripts/composer-fit-demo-regression.ts",
  "scripts/held-rows-demo-regression.ts",
  "scripts/sidebar-activity-demo-regression.ts",
  "scripts/workspace-touch-reorder-demo-regression.ts",
  "scripts/prompt-dock-demo-regression.ts",
  "scripts/plugin-actions-demo-regression.ts",
  "scripts/palette-machines-demo-regression.ts",
  "scripts/machine-dialog-regression.ts",
  "scripts/machine-conflict-regression.ts",
];

interface ScriptResult {
  script: string;
  seconds: number;
  code: number;
  output: string;
}

const repo = join(import.meta.dir, "..");

async function installChromium(): Promise<string> {
  const cli = join(repo, "node_modules/playwright-core/cli.js");
  if (process.env.CI) {
    console.log("[setup] Installing Chromium system dependencies...");
    const deps = Bun.spawnSync(["sudo", "bash", "scripts/ci-bounded-retry.sh", "300", Bun.which("bun") ?? "bun", cli, "install-deps", "chromium"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
    if (deps.exitCode !== 0) throw new Error("Failed to install Chromium system dependencies");
  }
  console.log("[setup] Installing Chromium browser...");
  const install = Bun.spawnSync(["bun", cli, "install", "chromium"], { cwd: repo, stdio: ["ignore", "inherit", "inherit"] });
  if (install.exitCode !== 0) throw new Error("Failed to install Chromium");
  const path = Bun.spawnSync(["bun", "-e", 'console.log(require("playwright-core").chromium.executablePath())'], { cwd: repo });
  return new TextDecoder().decode(path.stdout).trim();
}

async function buildDemo(dir: string): Promise<void> {
  console.log("[setup] Building demo app...");
  const started = Date.now();
  const child = Bun.spawn(["bun", "scripts/demo-build.ts", dir], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Demo build failed:\n${stdout}\n${stderr}`);
  console.log(`[setup] Demo build completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

async function runScript(script: string, env: Record<string, string>): Promise<ScriptResult> {
  const started = Date.now();
  const child = Bun.spawn(["bun", script], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return {
    script,
    seconds: (Date.now() - started) / 1000,
    code,
    output: stdout + stderr,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const requested = Number(process.env.BROWSER_WORKERS);
  const workers = Math.max(1, Math.min(
    requested >= 1 ? Math.floor(requested) : Math.min(Math.floor(availableParallelism() / 2), 6),
    ALL_SCRIPTS.length
  ));
  const scripts = process.env.BROWSER_SCRIPTS
    ? process.env.BROWSER_SCRIPTS.split(",").map((s) => s.trim()).filter(Boolean)
    : ALL_SCRIPTS;

  console.log(`Browser lane: ${scripts.length} scripts, ${workers} workers`);

  const chromePath = process.env.CHROME_PATH ?? await installChromium();
  const demoBuild = mkdtempSync(join(tmpdir(), "herdr-demo-parallel-"));
  await buildDemo(demoBuild);

  const checkDir = process.env.CHECK_DIR;
  const baseEvidenceDir = checkDir ? join(checkDir, "browser-evidence") : process.env.CI ? ".ci/browser-evidence" : undefined;
  if (baseEvidenceDir) mkdirSync(baseEvidenceDir, { recursive: true });

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

      const shouldDisableEvidence = baseEvidenceDir && (script === "scripts/ui-regression.ts" || script === "scripts/key-bar-customization-demo-regression.ts");

      console.log(`[worker-${workerId}] Starting ${script}`);
      const result = await runScript(script, {
        CHROME_PATH: chromePath,
        HERDR_DEMO_BUILD: demoBuild,
        UI_EVIDENCE_DIR: shouldDisableEvidence ? "" : (evidenceDir ?? ""),
        CHECK_BROWSER_EVIDENCE_DIR: evidenceDir ?? "",
      });
      results.push(result);
      const status = result.code === 0 ? "PASS" : "FAIL";
      console.log(`[worker-${workerId}] ${status} ${script} (${result.seconds.toFixed(1)}s)`);
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
    const status = result.code === 0 ? " " : "!";
    console.log(`${status}${result.script.padEnd(59)}${result.seconds.toFixed(1).padStart(8)}${String(result.code).padStart(6)}`);
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  const passed = results.filter((r) => r.code === 0).length;
  const failed = results.filter((r) => r.code !== 0);

  console.log("-".repeat(80));
  console.log(`Total: ${passed}/${results.length} passed in ${totalSeconds.toFixed(1)}s with ${workers} workers`);

  if (failed.length > 0) {
    console.log("\nFailed scripts:");
    for (const result of failed) {
      console.log(`  ${result.script} (exit ${result.code})`);
      console.log("  Output:");
      for (const line of result.output.split("\n").slice(-50)) {
        console.log(`    ${line}`);
      }
    }
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
