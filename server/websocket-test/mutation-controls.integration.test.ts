import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { websocketRunRoot } from "./create-server-harness.ts";
import { generateAllMutants } from "./mutation-source.ts";

const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidenceRoot = resolve(websocketRunRoot, "evidence/mutants");
const manifestPath = resolve(websocketRunRoot, "evidence/mutant-manifest.json");
const logPath = resolve(websocketRunRoot, "evidence/mutation-controls.jsonl");
const cleanupPath = resolve(websocketRunRoot, "evidence/mutation-controls-cleanup.json");
const cases = [
  { name: "utf8-byte-count", scenario: "S1", marker: "MUTATION_ASSERTION_S1_UTF8_BYTE_COUNT" },
  { name: "cumulative-ack", scenario: "S2", marker: "MUTATION_ASSERTION_S2_CUMULATIVE_ACK" },
  { name: "stale-stream-id", scenario: "S4", marker: "MUTATION_ASSERTION_S4_STALE_STREAM_ID" },
  { name: "pause-resume", scenario: "S7", marker: "MUTATION_ASSERTION_S7_PAUSE_RESUME" },
] as const;
const childTimeoutMs = 45000;

interface ChildResult {
  readonly name: (typeof cases)[number]["name"];
  readonly variant: "mutant" | "clean";
  readonly evidenceDir: string;
  readonly exitCode: number;
  readonly log: string;
  readonly scenario: string;
  readonly cleanup: unknown;
}

function c0Complete(value: unknown, scenario: string): boolean {
  const receipts = Array.isArray(value) ? value : typeof value === "object" && value !== null && "cases" in value ? value.cases : undefined;
  if (!Array.isArray(receipts) || receipts.length !== 1) return false;
  const receipt = receipts[0];
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return false;
  const r = receipt as Record<string, unknown>;
  return r["scenario"] === scenario && r["cleanupError"] === null && r["stateDirAbsent"] === true && r["stoppedPortHandshakeFailed"] === true &&
    typeof r["subscriptionCloseDelta"] === "number" && r["subscriptionCloseDelta"] > 0 && r["subscriptionsClosed"] === true &&
    r["fakeExitedResolved"] === true && typeof r["socketsOpened"] === "number" && r["socketsOpened"] > 0 &&
    r["socketsClosed"] === r["socketsOpened"];
}

async function runChild(name: ChildResult["name"], variant: ChildResult["variant"], serverIndex?: string): Promise<ChildResult> {
  const evidenceDir = resolve(evidenceRoot, `${name}-${variant}-${randomUUID()}`);
  await mkdir(evidenceDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SODAM_WS_MUTATION_CASE: name,
    SODAM_WS_RUN_ROOT: websocketRunRoot,
    SODAM_WS_EVIDENCE_DIR: evidenceDir,
  };
  if (serverIndex === undefined) delete env["SODAM_WS_SERVER_INDEX"];
  else env["SODAM_WS_SERVER_INDEX"] = serverIndex;
  const child = Bun.spawn(["bun", "--config=bunfig.websocket.toml", "test", "--isolate", "server/websocket-test/mutation-probe.integration.test.ts"], {
    cwd: sourceRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill(); }, childTimeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(watchdog);
  const log = `${stdout}${stderr}`;
  await writeFile(resolve(evidenceDir, "child.log"), log, "utf8");
  const scenario = await readFile(resolve(evidenceDir, "scenario.jsonl"), "utf8").catch(() => "");
  const cleanup = await readFile(resolve(evidenceDir, "scenario-cleanup.json"), "utf8").then((raw) => JSON.parse(raw) as unknown, () => null);
  return { name, variant, evidenceDir, exitCode: timedOut ? -1 : exitCode, log: timedOut ? `${log}\nCHILD_WATCHDOG_TIMEOUT` : log, scenario, cleanup };
}

test("four websocket mutations fail their named assertions and clean controls pass", async () => {
  await mkdir(dirname(manifestPath), { recursive: true });
  await generateAllMutants();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { mutants: { name: string; outputPath: string }[] };
  expect(manifest.mutants.map((item) => item.name)).toEqual(cases.map((item) => item.name));
  for (const item of manifest.mutants) expect(resolve(item.outputPath)).toBe(resolve(websocketRunRoot, "mutants", item.name));
  const results: ChildResult[] = [];
  for (const item of cases) {
    const overlay = manifest.mutants.find((entry) => entry.name === item.name);
    if (!overlay) throw new Error(`missing mutant overlay ${item.name}`);
    results.push(await runChild(item.name, "mutant", resolve(overlay.outputPath, "server/index.ts")));
    results.push(await runChild(item.name, "clean"));
  }

  const lines = results.map((result) => {
    const item = cases.find((candidate) => candidate.name === result.name);
    if (!item) throw new Error(`missing mutation case ${result.name}`);
    const mutantPass = result.variant === "mutant" && result.exitCode !== 0 && result.log.includes(item.marker) && result.scenario.includes(item.marker) && c0Complete(result.cleanup, item.scenario);
    const cleanPass = result.variant === "clean" && result.exitCode === 0 && !result.log.includes("MUTATION_ASSERTION_") && c0Complete(result.cleanup, item.scenario);
    return JSON.stringify({ ...result, mutantPass, cleanPass });
  });
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, `${lines.join("\n")}\n`, "utf8");
  await writeFile(cleanupPath, `${JSON.stringify({ receipts: results.map(({ name, variant, evidenceDir, cleanup }) => {
    const item = cases.find((candidate) => candidate.name === name);
    if (!item) throw new Error(`missing mutation case ${name}`);
    return { name, variant, evidenceDir, cleanup, c0Complete: c0Complete(cleanup, item.scenario) };
  }) }, null, 2)}\n`, "utf8");

  expect(results).toHaveLength(8);
  for (const result of results) {
    const item = cases.find((candidate) => candidate.name === result.name);
    if (!item) throw new Error(`missing mutation case ${result.name}`);
    expect(c0Complete(result.cleanup, item.scenario)).toBe(true);
    expect(result.scenario).not.toBe("");
    expect(result.cleanup).not.toBeNull();
    expect(result.scenario).toContain(`"scenario":"${item.scenario}"`);
    expect(resolve(result.evidenceDir).startsWith(`${resolve(evidenceRoot)}${process.platform === "win32" ? "\\" : "/"}`)).toBe(true);
    expect(result.evidenceDir).toContain(`${result.name}-${result.variant}-`);
  }
  for (const item of cases) {
    const mutant = results.find((result) => result.name === item.name && result.variant === "mutant");
    const clean = results.find((result) => result.name === item.name && result.variant === "clean");
    if (!mutant || !clean) throw new Error(`missing mutant/clean result pair for ${item.name}`);
    expect(mutant.exitCode).not.toBe(0);
    expect(mutant.log).toContain(item.marker);
    expect(mutant.scenario).toContain(item.marker);
    expect(clean.exitCode).toBe(0);
    expect(clean.log).not.toContain("MUTATION_ASSERTION_");
  }
}, 600000);
