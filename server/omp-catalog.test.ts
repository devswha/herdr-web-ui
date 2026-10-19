import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import * as ompProbe from "./omp-process.ts";
import * as omo from "./omo.ts";
import { forgetOmpCatalogs, listOmpCatalog, ompCatalogCommand, paneOmpCatalog, parseOmpCatalog, type OmpCatalogModel } from "./omp-catalog.ts";

// the shape of `omp models --json`, omp 18.11.1
const LISTING = JSON.stringify({ models: [
  { provider: "anthropic", kind: "chat", id: "claude-opus-5-5", selector: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true, thinking: ["low", "high"] },
  { provider: "openai-codex", kind: "chat", id: "gpt-6.1-sol", selector: "openai-codex/gpt-6.1-sol", name: "GPT 6.1 Sol", reasoning: true, thinking: ["low", "max"] },
] });

describe("parseOmpCatalog", () => {
  it("keeps each row's id and the name omp draws", () => {
    expect(parseOmpCatalog(LISTING)).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }, { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" }]);
    // omp draws the id where a model has no name
    expect(parseOmpCatalog(JSON.stringify({ models: [{ id: "local-model" }, { id: "named", name: "" }] }))).toEqual([{ id: "local-model", name: "local-model" }, { id: "named", name: "named" }]);
  });

  it("names nothing from a listing in another shape", () => {
    for (const text of ["", "not json", "null", "{}", '{"models":null}']) expect(parseOmpCatalog(text)).toEqual([]);
    expect(parseOmpCatalog(JSON.stringify({ models: [null, "id", { name: "No id" }, { id: 4 }] }))).toEqual([]);
  });
});

describe("ompCatalogCommand", () => {
  it("lists with the pane's own omp and profile, never its extensions", () => {
    expect(ompCatalogCommand(["omp", "--model", "openai-codex/gpt-6.1-sol"], null)).toEqual(["omp", "models", "--json", "--no-extensions"]);
    expect(ompCatalogCommand(["bun", "/home/u/.bun/bin/omp", "--profile", "work"], null)).toEqual(["bun", "/home/u/.bun/bin/omp", "--profile", "work", "models", "--json", "--no-extensions"]);
    expect(ompCatalogCommand(["/usr/local/bin/omp", "--profile=work"], ["OMP_PROFILE=home"])).toEqual(["/usr/local/bin/omp", "--profile", "work", "models", "--json", "--no-extensions"]);
    expect(ompCatalogCommand(["omp"], ["PATH=/bin", "OMP_PROFILE=home"])).toEqual(["omp", "--profile", "home", "models", "--json", "--no-extensions"]);
  });

  it("lists nothing for another process or a profile name it cannot pass on", () => {
    expect(ompCatalogCommand(["omo"], null)).toBeNull();
    expect(ompCatalogCommand([], null)).toBeNull();
    expect(ompCatalogCommand(["omp", "--profile", "a b"], null)).toBeNull();
    for (const args of [["--profile"], ["--profile", "."], ["--profile", ".."], ["--config", "custom.yml"], ["-e", "provider.ts"]]) {
      expect(ompCatalogCommand(["omp", ...args], null)).toBeNull();
    }
  });
});

describe.skipIf(process.platform === "win32")("paneOmpCatalog", () => {
  const restores: Array<() => void> = [];
  afterEach(() => { for (const restore of restores.splice(0)) restore(); forgetOmpCatalogs(); });

  const fakeOmp = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omp-catalog-"));
    const bin = join(dir, "omp");
    // each listing leaves a mark, so the test can count them
    writeFileSync(bin, `#!/bin/sh\necho x >> "${join(dir, "calls")}"\n${body}\n`, { mode: 0o755 });
    restores.push(() => rmSync(dir, { recursive: true, force: true }));
    return { dir, bin, calls: () => Bun.file(join(dir, "calls")).text().then((text) => text.split("\n").filter(Boolean).length, () => 0) };
  };
  const foreground = (processes: { pid: number; argv: string[] }[], mockMemory = true) => {
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ foreground_processes: processes }) as never);
    restores.push(() => info.mockRestore());
    if (mockMemory) {
      const probe = spyOn(ompProbe, "ompProcessMemory").mockImplementation(async (pid) => {
        const foreground = processes.find((entry) => entry.pid === pid);
        return foreground ? { argv: foreground.argv, environ: [`HOME=${tmpdir()}`, "PATH=/usr/bin:/bin"], executable: foreground.argv[0] } : null;
      });
      restores.push(() => probe.mockRestore());
    }
  };

  const liveOmp = (environ: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-omp-live-"));
    const bin = join(dir, "omp");
    writeFileSync(bin, `if (process.argv.includes("models")) console.log(JSON.stringify({models:[{id:process.env.OMP_PROFILE || "default",name:process.env.HOME || "missing"}]})); else { console.log("ready"); process.stdin.resume(); }`);
    const child = Bun.spawn([process.execPath, bin], { cwd: dir, env: { PATH: process.env["PATH"] ?? "", HOME: dir, ...environ }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    restores.push(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
    return { dir, bin, child };
  };

  it.skipIf(process.platform !== "linux")("never executes project Bun preloads during metadata refresh", async () => {
    const omp = liveOmp();
    await omp.child.stdout.getReader().read();
    const marker = join(omp.dir, "preloaded");
    writeFileSync(join(omp.dir, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`);
    writeFileSync(join(omp.dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    foreground([{ pid: omp.child.pid, argv: [process.execPath, omp.bin] }], false);
    const models = await paneOmpCatalog("preload", omp.dir);
    expect(existsSync(marker)).toBe(false);
    expect(models).toEqual([{ id: "default", name: omp.dir }]);
  });

  it.skipIf(process.platform !== "linux")("recovers the live argv omitted by WSL", async () => {
    const omp = liveOmp();
    await omp.child.stdout.getReader().read();
    foreground([{ pid: omp.child.pid, argv: [] }], false);
    expect(await paneOmpCatalog("wsl-argv", omp.dir)).toEqual([{ id: "default", name: omp.dir }]);
  });

  it.skipIf(process.platform !== "linux")("uses the pane runtime rather than a competing server PATH entry", async () => {
    const omp = liveOmp();
    await omp.child.stdout.getReader().read();
    const other = join(omp.dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "bun"), `#!/bin/sh\nprintf '%s\\n' '{"models":[{"id":"wrong-runtime","name":"wrong"}]}'\n`, { mode: 0o755 });
    const path = process.env["PATH"];
    process.env["PATH"] = other;
    restores.push(() => { if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path; });
    foreground([{ pid: omp.child.pid, argv: ["bun", omp.bin] }], false);
    expect((await ompProbe.ompProcessMemory(omp.child.pid, true))?.argv).toEqual([process.execPath, omp.bin]);
    const spawn = spyOn(Bun, "spawn");
    restores.push(() => spawn.mockRestore());
    const models = await paneOmpCatalog("runtime", omp.dir);
    expect(spawn.mock.calls.some(([command]) => Array.isArray(command) && command[0] === "bun")).toBe(false);
    expect(models).toEqual([{ id: "default", name: omp.dir }]);
  });

  it.skipIf(process.platform !== "linux")("does not inherit the server profile or home when the pane has no profile", async () => {
    const omp = liveOmp();
    await omp.child.stdout.getReader().read();
    const profile = process.env["OMP_PROFILE"];
    process.env["OMP_PROFILE"] = "server";
    restores.push(() => { if (profile === undefined) delete process.env["OMP_PROFILE"]; else process.env["OMP_PROFILE"] = profile; });
    foreground([{ pid: omp.child.pid, argv: [process.execPath, omp.bin] }], false);
    expect(await paneOmpCatalog("profile", omp.dir)).toEqual([{ id: "default", name: omp.dir }]);
  });

  it("uses the bounded memory probe instead of synchronous procfs environment reads", async () => {
    foreground([{ pid: process.pid, argv: ["omp"] }], false);
    const sync = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("blocked procfs read"); });
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(null);
    restores.push(() => { sync.mockRestore(); probe.mockRestore(); });
    expect(await paneOmpCatalog("bounded-procfs", tmpdir())).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalled();
  });

  it("cancels an inherited stdout pipe at the listing deadline even after the parent exits", async () => {
    const omp = fakeOmp("exit 0");
    foreground([{ pid: 1, argv: [omp.bin] }]);
    let cancelled = false;
    const pipe = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const spawn = spyOn(Bun, "spawn").mockReturnValue({ stdout: pipe, exited: Promise.resolve(0), kill() {} } as never);
    restores.push(() => spawn.mockRestore());
    expect(await listOmpCatalog([omp.bin], { PATH: "/usr/bin:/bin", HOME: omp.dir }, 20)).toEqual([]);
    expect(cancelled).toBe(true);
  });

  it("keeps in-flight deduplication separate from the completed cache and bounds admission", async () => {
    const omp = fakeOmp("exit 0");
    foreground([{ pid: 1, argv: [omp.bin] }]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: Array<() => void> = [];
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      const stdout = new ReadableStream<Uint8Array>({ start(controller) {
        void gate.then(() => { controller.enqueue(new TextEncoder().encode(LISTING)); controller.close(); });
      } });
      started.shift()?.();
      return { stdout, exited: gate.then(() => 0), kill() {} } as never;
    });
    restores.push(() => spawn.mockRestore());
    const flights: Promise<OmpCatalogModel[]>[] = [];
    try {
      for (let at = 0; at < 16; at++) {
        const ready = new Promise<void>((resolve) => started.push(resolve));
        flights.push(paneOmpCatalog("busy", `${omp.dir}/${at}`));
        await ready;
      }
      expect(await paneOmpCatalog("overflow", `${omp.dir}/17`)).toEqual([]);
      // A conversation can leave an in-flight listing running after its short response budget.
      expect(await paneOmpCatalog("busy", `${omp.dir}/0`, 20)).toEqual([]);
      flights.push(paneOmpCatalog("busy", `${omp.dir}/0`));
      release?.();
      const results = await Promise.all(flights);
      expect(spawn).toHaveBeenCalledTimes(16);
      expect(results.every((models) => models.length === 2)).toBe(true);
    } finally { release?.(); await Promise.all(flights); }
  });

  it("lists the catalog of the pane's own omp once a minute", async () => {
    const omp = fakeOmp(`cat <<'EOF'\n${LISTING}\nEOF`);
    foreground([{ pid: 1, argv: [omp.bin, "--model", "openai-codex/gpt-6.1-sol"] }]);
    expect(await paneOmpCatalog("pane", omp.dir)).toEqual(parseOmpCatalog(LISTING));
    expect(await paneOmpCatalog("pane", omp.dir)).toEqual(parseOmpCatalog(LISTING));
    expect(await omp.calls()).toBe(1);
  });

  it("names nothing when omp fails or the pane does not run exactly one omp", async () => {
    const failing = fakeOmp("exit 1");
    foreground([{ pid: 1, argv: [failing.bin] }]);
    expect(await paneOmpCatalog("pane", failing.dir)).toEqual([]);
    // a failed listing is not kept
    expect(await paneOmpCatalog("pane", failing.dir)).toEqual([]);
    expect(await failing.calls()).toBe(2);
    // a read that joins a listing still running gets the same empty answer, not its failure
    expect(await Promise.all([paneOmpCatalog("pane", failing.dir), paneOmpCatalog("pane", failing.dir)])).toEqual([[], []]);
    expect(await failing.calls()).toBe(3);
    for (const restore of restores.splice(0)) restore();
    const omp = fakeOmp(`echo '${LISTING}'`);
    foreground([{ pid: 1, argv: [omp.bin] }, { pid: 2, argv: [omp.bin] }]);
    expect(await paneOmpCatalog("pane", omp.dir)).toEqual([]);
    foreground([{ pid: 1, argv: ["bash"] }]);
    expect(await paneOmpCatalog("pane", omp.dir)).toEqual([]);
    expect(await omp.calls()).toBe(0);
  });
});
