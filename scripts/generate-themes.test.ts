import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DESIGN_BEGIN, DESIGN_END, OUTPUTS, renderAll, renderDesign, renderIndex, renderManifest, renderModule, SOURCE } from "./generate-themes.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATOR = join(ROOT, "scripts", "generate-themes.ts");
const read = (root: string, file: string): string => readFileSync(join(root, file), "utf8");
const css = read(ROOT, SOURCE);

const copies: string[] = [];
afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary repo holding only the generator's input and outputs, so a run never touches committed files. */
function copyRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "generate-themes-"));
  copies.push(dir);
  for (const file of [SOURCE, ...Object.values(OUTPUTS)]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

async function run(args: string[]): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn(["bun", "run", GENERATOR, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, output: stdout + stderr };
}

describe("generate-themes", () => {
  it("renders exactly the committed outputs from the committed CSS", () => {
    for (const { path, content } of renderAll(ROOT)) expect(content, path).toBe(read(ROOT, path));
  });

  it("is deterministic", () => {
    expect(renderModule(css)).toBe(renderModule(css));
    expect(renderAll(ROOT)).toEqual(renderAll(ROOT));
  });

  it("rejects a duplicated, missing or out-of-order DESIGN.md marker, naming it", () => {
    const design = read(ROOT, OUTPUTS.design);
    expect(() => renderDesign(css, design.replace(DESIGN_BEGIN, `${DESIGN_BEGIN}\n${DESIGN_BEGIN}`))).toThrow(`DESIGN.md: marker ${DESIGN_BEGIN} found 2 times`);
    expect(() => renderDesign(css, design.replace(DESIGN_END, ""))).toThrow(`DESIGN.md: marker ${DESIGN_END} found 0 times`);
    expect(() => renderDesign(css, design.replace(DESIGN_BEGIN, "@@").replace(DESIGN_END, DESIGN_BEGIN).replace("@@", DESIGN_END))).toThrow("comes before");
  });

  it("rejects a theme-color meta tag or manifest key found other than once", () => {
    const html = read(ROOT, OUTPUTS.index);
    const tag = /<meta name="theme-color"[^>]*>/.exec(html)![0];
    expect(() => renderIndex(css, html.replace(tag, ""))).toThrow("found 0 times");
    expect(() => renderIndex(css, html.replace(tag, `${tag}\n${tag}`))).toThrow("found 2 times");
    const manifest = read(ROOT, OUTPUTS.manifest);
    expect(() => renderManifest(css, manifest.replace(/"theme_color": "[^"]*",\n/, ""))).toThrow('"theme_color" found 0 times');
  });

  it("changes nothing outside the DESIGN.md region", () => {
    const design = read(ROOT, OUTPUTS.design);
    const edited = design.replace(/(\| Surface\/base \| `--bg` \| `)#[0-9a-f]{6}/, "$1#000000");
    expect(edited).not.toBe(design);
    const rendered = renderDesign(css, edited);
    expect(rendered).toBe(design);
    const outside = (text: string): string[] => [text.slice(0, text.indexOf(DESIGN_BEGIN)), text.slice(text.indexOf(DESIGN_END))];
    expect(outside(rendered)).toEqual(outside(edited));
  });

  it("writes every copy from one edit in src/styles.css and never writes the CSS", async () => {
    const root = copyRoot();
    const source = read(root, SOURCE).replace("--bg-panel: #181613;", "--bg-panel: #1a1714;");
    expect(source).not.toBe(css);
    writeFileSync(join(root, SOURCE), source);

    const stale = await run(["--check", "--root", root]);
    expect(stale.exitCode).toBe(1);
    for (const file of Object.values(OUTPUTS)) expect(stale.output).toContain(`STALE ${file} - Run: bun run generate:themes`);
    expect(read(root, OUTPUTS.module)).toBe(read(ROOT, OUTPUTS.module));

    expect((await run(["--root", root])).exitCode).toBe(0);
    expect(read(root, SOURCE)).toBe(source);
    expect(read(root, OUTPUTS.module)).toContain('bgPanel: "#1a1714"');
    expect(read(root, OUTPUTS.design)).toContain("| Surface/panel | `--bg-panel` | `#1a1714` |");
    expect(read(root, OUTPUTS.index)).toContain('<meta name="theme-color" content="#1a1714" />');
    expect(JSON.parse(read(root, OUTPUTS.manifest)).theme_color).toBe("#1a1714");

    const fresh = await run(["--check", "--root", root]);
    expect([fresh.exitCode, fresh.output.trim()]).toEqual([0, "generated themes are up to date"]);
  });

  it("fails --check with the marker named when a copy cannot be generated", async () => {
    const root = copyRoot();
    writeFileSync(join(root, OUTPUTS.design), read(root, OUTPUTS.design).replace(DESIGN_BEGIN, `${DESIGN_BEGIN}\n${DESIGN_BEGIN}`));
    const result = await run(["--check", "--root", root]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`marker ${DESIGN_BEGIN} found 2 times`);
  });
});
