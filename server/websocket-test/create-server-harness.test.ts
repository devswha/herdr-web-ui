import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServerHarness, defaultServerIndex, evidenceDirectory, resolveContainedPath, websocketRunRoot } from "./create-server-harness.ts";
import * as fakeHerdrClient from "./fake-herdr-client.ts";

const checkoutRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const runRoot = websocketRunRoot;
const defaultPath = resolve(checkoutRoot, "server/index.ts");
const evidencePath = resolve(evidenceDirectory(), "create-server-smoke.jsonl");
const originalIndexOverride = process.env.SODAM_WS_SERVER_INDEX;
const originalEvidenceOverride = process.env.SODAM_WS_EVIDENCE_DIR;
const originalSocket = process.env.HERDR_SOCKET;

afterEach(() => {
  if (originalIndexOverride === undefined) delete process.env.SODAM_WS_SERVER_INDEX;
  else process.env.SODAM_WS_SERVER_INDEX = originalIndexOverride;
  if (originalEvidenceOverride === undefined) delete process.env.SODAM_WS_EVIDENCE_DIR;
  else process.env.SODAM_WS_EVIDENCE_DIR = originalEvidenceOverride;
  if (originalSocket === undefined) delete process.env.HERDR_SOCKET;
  else process.env.HERDR_SOCKET = originalSocket;
});

describe("original createServer harness boundary", () => {
  test("uses the original source by default and contains allowed overrides", () => {
    delete process.env.SODAM_WS_SERVER_INDEX;
    delete process.env.SODAM_WS_EVIDENCE_DIR;
    expect(defaultServerIndex()).toBe(resolve(defaultPath));
    expect(evidenceDirectory()).toBe(resolve(runRoot, "evidence"));
    process.env.SODAM_WS_SERVER_INDEX = resolve(runRoot, "alternate/index.ts");
    process.env.SODAM_WS_EVIDENCE_DIR = resolve(runRoot, "alternate/evidence");
    expect(defaultServerIndex()).toBe(resolve(runRoot, "alternate/index.ts"));
    expect(evidenceDirectory()).toBe(resolve(runRoot, "alternate/evidence"));
  });

  test("rejects an override outside the run root", () => {
    process.env.SODAM_WS_SERVER_INDEX = defaultPath;
    expect(() => defaultServerIndex()).toThrow("path must resolve under");
    const siblingRunRoot = resolve(runRoot, "..", `${basename(runRoot)}-attacker`);
    const siblingStateDir = resolve(siblingRunRoot, "state-1");
    expect(() => resolveContainedPath(siblingStateDir, siblingStateDir)).toThrow("path must resolve under");
  });

  test("registers fake modules before import and cleans all observed resources", async () => {
    delete process.env.SODAM_WS_SERVER_INDEX;
    delete process.env.SODAM_WS_EVIDENCE_DIR;
    fakeHerdrClient.resetFakeHerdrCounters();
    const harness = await createServerHarness();
    expect(harness.serverIndex).toBe(resolve(defaultPath));
    const baseUrl = new URL(harness.baseUrl);
    expect(baseUrl.protocol).toBe("ws:");
    expect(baseUrl.hostname).toBe("127.0.0.1");
    expect(Number(baseUrl.port)).toBeGreaterThan(0);
    expect(harness.stateDir.startsWith(`${resolve(runRoot)}${process.platform === "win32" ? "\\" : "/"}state-`)).toBe(true);
    const opening = harness.openSocket();
    expect(opening.readyState).toBe(WebSocket.CONNECTING);
    const openEvent = harness.prearmSocketEvent("open");
    const snapshot = new Promise<MessageEvent<string>>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("timed out waiting for initial snapshot")), 5000);
      opening.addEventListener("message", (event: MessageEvent<string>) => {
        clearTimeout(timer);
        resolvePromise(event);
      }, { once: true });
    });
    const [opened, snapshotEvent] = await Promise.all([openEvent, snapshot]);
    expect(opened.socket).toBe(opening);
    expect(snapshotEvent.data).toContain('"type":"snapshot"');
    const cleanup = await harness.cleanup();
    let stateAbsent = false;
    try {
      await access(harness.stateDir);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") stateAbsent = true;
      else throw error;
    }
    expect(stateAbsent).toBe(true);
    expect(harness.instances).toHaveLength(0);
    expect(cleanup.subscriptionCloseDelta).toBeGreaterThanOrEqual(0);
    const evidence = {
      kind: "create-server-smoke",
      testCommand: "bun --config=bunfig.websocket.toml test --isolate server/websocket-test/create-server-harness.test.ts",
      serverIndex: harness.serverIndex,
      baseUrl: harness.baseUrl,
      port: Number(baseUrl.port),
      endpointHost: baseUrl.hostname,
      stateDirAbsentAfterCleanup: stateAbsent,
      stateDir: harness.stateDir,
      subscriptionCloseDelta: cleanup.subscriptionCloseDelta,
      fakePtyInstancesAtCleanup: harness.instances.length,
      herdrSocketRestored: process.env.HERDR_SOCKET === originalSocket,
      bunVersion: Bun.version,
      externalHerdrCalls: 0,
    };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`);
    expect((await readFile(evidencePath, "utf8")).trim()).toBe(JSON.stringify(evidence));
    expect(cleanup.subscriptionCloseDelta).toBeGreaterThan(0);
  });
});
