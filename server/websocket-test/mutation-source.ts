import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { websocketRunRoot } from "./create-server-harness.ts";

const sourceRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceIndex = join(sourceRoot, "server/index.ts");
const sourceWindow = join(sourceRoot, "server/output-window.ts");
const mutantsRoot = join(websocketRunRoot, "mutants");
const manifestPath = join(websocketRunRoot, "evidence/mutant-manifest.json");

export const mutationAnchors = {
  "utf8-byte-count": "const bytes = Buffer.byteLength(data);",
  "cumulative-ack": "this.acknowledged = Math.max(this.acknowledged, offset);",
  "stale-stream-id": "if (window && window.id === message.stream_id && !window.acknowledge(message.stream_id, message.offset)) {",
  "pause-resume": "else attachment.pty.resume();",
} as const;

export type MutantName = keyof typeof mutationAnchors;

interface Mutation {
  readonly name: MutantName;
  readonly sourcePath: string;
  readonly anchor: string;
  readonly replacement: string;
}

const mutations: readonly Mutation[] = [
  { name: "utf8-byte-count", sourcePath: sourceIndex, anchor: mutationAnchors["utf8-byte-count"], replacement: "const bytes = data.length;" },
  { name: "cumulative-ack", sourcePath: sourceWindow, anchor: mutationAnchors["cumulative-ack"], replacement: "this.acknowledged = offset;" },
  { name: "stale-stream-id", sourcePath: sourceIndex, anchor: mutationAnchors["stale-stream-id"], replacement: "if (window && !window.acknowledge(message.stream_id, message.offset)) {" },
  { name: "pause-resume", sourcePath: sourceIndex, anchor: mutationAnchors["pause-resume"], replacement: "else { /* mutation: resume disabled */ }" },
];

function replaceUniqueAnchor(source: string, anchor: string, replacement: string, label: string): string {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label}: expected exactly one source anchor`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

function assertUniqueAnchor(source: string, anchor: string, label: string): void {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`${label}: expected exactly one source anchor`);
  }
}

function assertUnder(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path is not contained under ${root}: ${candidate}`);
  }
}

async function assertDoesNotExist(path: string, label: string): Promise<void> {
  try {
    await access(path);
    throw new Error(`${label} already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} already exists:`)) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function transformedIndex(source: string, overlayIndex: string, overlayWindow: string): string {
  const file = ts.createSourceFile(sourceIndex, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const sourceDir = dirname(sourceIndex);
  const paired = resolve(overlayWindow);

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const specifier = moduleSpecifier.text;
    if (!specifier.startsWith(".")) continue;
    const cleanTarget = resolve(sourceDir, specifier);
    const resolvedTarget = cleanTarget === resolve(sourceWindow) ? paired : cleanTarget;
    if (cleanTarget !== resolve(sourceWindow)) assertUnder(sourceRoot, cleanTarget);
    if (resolvedTarget === paired) assertUnder(dirname(overlayIndex), resolvedTarget);
    const quoted = JSON.stringify(resolvedTarget).replaceAll("\\\\", "/");
    edits.push({ start: moduleSpecifier.getStart(file), end: moduleSpecifier.end, value: quoted });
  }

  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

async function ensureFreshVariant(name: MutantName, root: string): Promise<string> {
  const outputDir = resolve(root, name);
  assertUnder(root, outputDir);
  try {
    await readdir(outputDir);
    throw new Error(`variant output already exists: ${outputDir}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("variant output already exists:")) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return outputDir;
}

export async function generateMutant(name: string, options: { sourceText?: string; outputRoot?: string } = {}): Promise<{ name: MutantName; sourceHash: string; anchor: string; changedCopyPaths: string[]; outputPath: string }> {
  if (!Object.hasOwn(mutationAnchors, name)) throw new Error(`unknown mutant: ${name}`);
  const outputRoot = resolve(options.outputRoot ?? mutantsRoot);
  assertUnder(websocketRunRoot, outputRoot);
  const mutation = mutations.find((item) => item.name === name);
  if (!mutation) throw new Error(`mutation definition missing: ${name}`);
  const source = options.sourceText ?? await readFile(mutation.sourcePath, "utf8");
  assertUniqueAnchor(source, mutation.anchor, name);
  const variantDir = await ensureFreshVariant(mutation.name, outputRoot);
  const serverDir = join(variantDir, "server");
  const overlayIndex = join(serverDir, "index.ts");
  const overlayWindow = join(serverDir, "output-window.ts");
  const indexSource = mutation.sourcePath === sourceIndex ? source : await readFile(sourceIndex, "utf8");
  const windowSource = mutation.sourcePath === sourceWindow ? source : await readFile(sourceWindow, "utf8");
  const cleanIndex = mutation.sourcePath === sourceIndex ? replaceUniqueAnchor(indexSource, mutation.anchor, mutation.replacement, name) : indexSource;
  const cleanWindow = mutation.sourcePath === sourceWindow ? replaceUniqueAnchor(windowSource, mutation.anchor, mutation.replacement, name) : windowSource;
  const overlayIndexText = transformedIndex(cleanIndex, overlayIndex, overlayWindow);
  const windowText = cleanWindow;
  const importAudit = ts.createSourceFile(overlayIndex, overlayIndexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of importAudit.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) continue;
    const specifier = moduleSpecifier.text;
    if (specifier.startsWith(".")) throw new Error(`relative import remains in overlay: ${specifier}`);
    if (specifier.startsWith("node:") || specifier === "bun" || !isAbsolute(specifier)) continue;
    if (resolve(specifier) !== resolve(overlayWindow) && !resolve(specifier).startsWith(`${sourceRoot}${sep}`)) {
      throw new Error(`unexpected rewritten import target: ${specifier}`);
    }
  }

  await mkdir(serverDir, { recursive: true });
  await writeFile(overlayIndex, overlayIndexText, "utf8");
  await writeFile(overlayWindow, windowText, "utf8");
  return {
    name: mutation.name,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    anchor: mutation.anchor,
    changedCopyPaths: [overlayIndex, ...(mutation.sourcePath === sourceIndex ? [] : [overlayWindow])],
    outputPath: variantDir,
  };
}

async function currentSourceCommit(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: sourceRoot, stdout: "pipe", stderr: "pipe" });
  const [commit, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${stderr.trim()}`);
  return commit.trim();
}

export async function generateAllMutants(options: { outputRoot?: string; manifestPath?: string } = {}): Promise<void> {
  const outputRoot = resolve(options.outputRoot ?? mutantsRoot);
  const outputManifest = resolve(options.manifestPath ?? manifestPath);
  assertUnder(websocketRunRoot, outputRoot);
  assertUnder(websocketRunRoot, outputManifest);
  await assertDoesNotExist(outputManifest, "manifest");
  for (const mutation of mutations) await assertDoesNotExist(resolve(outputRoot, mutation.name), "variant output");

  const [indexText, windowText, sourceCommit] = await Promise.all([
    readFile(sourceIndex, "utf8"),
    readFile(sourceWindow, "utf8"),
    currentSourceCommit(),
  ]);
  const entries = [];
  for (const mutation of mutations) entries.push(await generateMutant(mutation.name, { outputRoot }));
  await mkdir(dirname(outputManifest), { recursive: true });
  await writeFile(outputManifest, `${JSON.stringify({
    sourceCommit,
    sourceRoot,
    sourceHashes: {
      "server/index.ts": createHash("sha256").update(indexText).digest("hex"),
      "server/output-window.ts": createHash("sha256").update(windowText).digest("hex"),
    },
    mutants: entries,
  }, null, 2)}\n`, "utf8");
}

if (import.meta.main) await generateAllMutants();
