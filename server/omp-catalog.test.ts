import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { forgetOmpCatalogs, ompCatalogCommand, paneOmpCatalog, parseOmpCatalog } from "./omp-catalog.ts";

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
    expect(ompCatalogCommand(["omp", "--profile"], null)).toEqual(["omp", "models", "--json", "--no-extensions"]);
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
  const foreground = (processes: { pid: number; argv: string[] }[]) => {
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async () => ({ foreground_processes: processes }) as never);
    restores.push(() => info.mockRestore());
  };

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
