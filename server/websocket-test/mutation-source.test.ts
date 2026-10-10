import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import ts from "typescript";
import { generateAllMutants, generateMutant, mutationAnchors } from "./mutation-source.ts";
import { websocketRunRoot } from "./create-server-harness.ts";

const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const names = ["utf8-byte-count", "cumulative-ack", "stale-stream-id", "pause-resume"] as const;
const indexPath = join(sourceRoot, "server/index.ts");
const windowPath = join(sourceRoot, "server/output-window.ts");

function assertUnder(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path is not contained under ${root}: ${candidate}`);
  }
}

test("generates isolated mutation overlays with current checkout provenance", async () => {
  await mkdir(websocketRunRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(websocketRunRoot, "mutation-source-fixture-"));
  const mutantsRoot = join(fixtureRoot, "mutants");
  const manifestPath = join(fixtureRoot, "evidence", "mutant-manifest.json");
  try {
    await generateAllMutants({ outputRoot: mutantsRoot, manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sourceCommit: string;
      sourceRoot: string;
      sourceHashes: Record<string, string>;
      mutants: Array<{ name: string; sourceHash: string; anchor: string; changedCopyPaths: string[]; outputPath: string }>;
    };
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
    const [currentCommit, gitError, gitExit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(gitExit).toBe(0);
    expect(gitError).toBe("");
    expect(manifest.sourceCommit).toBe(currentCommit.trim());
    expect(resolve(manifest.sourceRoot)).toBe(sourceRoot);
    expect(manifest.sourceHashes["server/index.ts"]).toBe(createHash("sha256").update(await readFile(indexPath)).digest("hex"));
    expect(manifest.sourceHashes["server/output-window.ts"]).toBe(createHash("sha256").update(await readFile(windowPath)).digest("hex"));
    expect(manifest.mutants.map((entry) => entry.name)).toEqual([...names]);
    for (const entry of manifest.mutants) {
      expect(entry.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.anchor).toBe(mutationAnchors[entry.name as keyof typeof mutationAnchors]);
      assertUnder(mutantsRoot, entry.outputPath);
      for (const copyPath of entry.changedCopyPaths) assertUnder(entry.outputPath, copyPath);
      const files = await readdir(join(entry.outputPath, "server"));
      expect(files.sort()).toEqual(["index.ts", "output-window.ts"]);
      const indexText = await readFile(join(entry.outputPath, "server/index.ts"), "utf8");
      const parsed = ts.createSourceFile("index.ts", indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const imports: string[] = [];
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const moduleSpecifier = statement.moduleSpecifier;
        if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
        const specifier = moduleSpecifier.text;
        imports.push(specifier);
        expect(specifier.startsWith(".")).toBe(false);
        if (specifier.startsWith("node:") || specifier === "bun") continue;
        if (!isAbsolute(specifier)) continue;
        const resolved = resolve(specifier);
        const rel = relative(sourceRoot, resolved);
        const contained = rel !== "" && rel !== "." && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
        const expected = resolved === resolve(join(entry.outputPath, "server/output-window.ts")) || contained;
        expect(expected).toBe(true);
      }
      expect(imports.some((specifier) => resolve(specifier) === resolve(join(entry.outputPath, "server/output-window.ts")))).toBe(true);
      expect(dirname(join(entry.outputPath, "server/index.ts"))).toBe(join(entry.outputPath, "server"));
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("unknown, absent, duplicate and escaping mutation inputs reject before writes", async () => {
  await mkdir(websocketRunRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(join(websocketRunRoot, "mutation-anchor-fixture-"));
  const outputRoot = join(fixtureRoot, "mutants");
  const variantDirectory = join(outputRoot, "utf8-byte-count");
  const indexSource = await readFile(indexPath, "utf8");
  const missingAnchorSource = indexSource.replace(mutationAnchors["utf8-byte-count"], "const bytes = Buffer.byteLength(data) + 1;");
  const duplicateAnchorSource = `${indexSource}\n${mutationAnchors["utf8-byte-count"]}\n`;
  try {
    await expect(generateMutant("unknown-mutant", { outputRoot })).rejects.toThrow("unknown mutant");
    await expect(access(join(outputRoot, "unknown-mutant"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(generateMutant("utf8-byte-count", { sourceText: missingAnchorSource, outputRoot })).rejects.toThrow("expected exactly one source anchor");
    await expect(access(variantDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(generateMutant("utf8-byte-count", { sourceText: duplicateAnchorSource, outputRoot })).rejects.toThrow("expected exactly one source anchor");
    await expect(access(variantDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(generateMutant("cumulative-ack", { sourceText: indexSource, outputRoot })).rejects.toThrow("expected exactly one source anchor");
    await expect(access(join(outputRoot, "cumulative-ack"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(generateMutant("utf8-byte-count", { outputRoot: resolve(websocketRunRoot, "..", `${websocketRunRoot.split(/[\\/]/).at(-1)}-attacker`) })).rejects.toThrow("path is not contained");
    await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
