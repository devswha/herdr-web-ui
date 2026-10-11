/** Actual pinned renderer, production chunks and enforcing app CSP; synthetic data only. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-mermaid-browser-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const fence = (source: string, close = true) => `\`\`\`mermaid\n${source}${close ? "\n```" : ""}`;
try {
  const repo = join(import.meta.dir, "..");
  const output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/mermaid-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  const bundle = await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    const outputs = Array.isArray(bundle) ? bundle : [bundle];
    writeFileSync(join(process.env.UI_EVIDENCE_DIR, "mermaid-bundle.json"), JSON.stringify(outputs.flatMap((result) => "output" in result ? result.output.filter((item) => item.type === "chunk").map((item) => ({ file: item.fileName, bytes: Buffer.byteLength(item.code), imports: item.imports, dynamicImports: item.dynamicImports, modules: Object.keys(item.modules) })) : []), null, 2));
  }
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before running its enforcing CSP regression");
  const unexpected: string[] = [];
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (!path.startsWith("/assets/") && path !== "/" && path !== "/favicon.ico") unexpected.push(path);
    return new Response(Bun.file(join(output, path === "/" ? "index.html" : path.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark" })));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const external: string[] = [];
  const scripts: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url());
    if (request.resourceType() === "script") scripts.push(new URL(request.url()).pathname);
  });
  const origin = `http://127.0.0.1:${server.port}`;
  await page.goto(origin);
  await page.getByText("Prose only.").waitFor();
  assert.ok(!scripts.some((path) => /\/mermaid-/.test(path)), "prose does not fetch the renderer");
  const unfinished = fence("flowchart LR\nA[아직 작성중] --> B", false);
  await page.evaluate((text) => window.mermaidQA.text(text), unfinished);
  await page.locator(".markdown-code").waitFor();
  assert.ok(!scripts.some((path) => /\/mermaid-/.test(path)), "an open fence does not fetch the renderer");
  assert.equal(await page.locator(".mermaid-image").count(), 0);

  const sources = ["flowchart LR\nA[시작] --> B[완료]", "sequenceDiagram\nAlice->>Bob: hello", "classDiagram\nAnimal <|-- Duck", "stateDiagram-v2\n[*] --> Ready"];
  await page.evaluate((text) => window.mermaidQA.text(text), sources.map((source) => fence(source)).join("\n\n"));
  try {
    await page.waitForFunction(() => document.querySelectorAll<HTMLImageElement>(".mermaid-image").length === 4 && [...document.querySelectorAll<HTMLImageElement>(".mermaid-image")].every((image) => image.complete && image.naturalWidth > 0));
  } catch (error) {
    console.error("diagram diagnostics", await page.evaluate(async (sources) => Promise.all(sources.map(window.mermaidQA.diagnose)), sources));
    throw error;
  }
  assert.equal(await page.locator(".mermaid-render-host").count(), 0, "owned containers are removed without deleting another diagram");
  const block = page.locator(".mermaid-block").first();
  await block.getByRole("button", { name: "Source", exact: true }).click();
  assert.equal(await block.locator("code").textContent(), sources[0]);
  await block.getByRole("button", { name: "Diagram", exact: true }).click();
  await block.getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), sources[0]);
  await block.getByRole("button", { name: "Expand diagram", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Mermaid diagram", exact: true });
  await dialog.waitFor();
  const fittedWidth = await dialog.locator(".mermaid-image").evaluate((image) => image.getBoundingClientRect().width);
  await page.keyboard.press("-");
  await page.waitForFunction((before) => document.querySelector(".mermaid-large-stage img")!.getBoundingClientRect().width < before, fittedWidth);
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.keyboard.press("0");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest(".mermaid-dialog"))), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await block.getByRole("button", { name: "Expand diagram", exact: true }).evaluate((node) => node === document.activeElement), true);
  const before = await block.locator(".mermaid-image").getAttribute("src");
  await page.evaluate(() => window.mermaidQA.theme("light"));
  await page.waitForFunction((old) => document.querySelector<HTMLImageElement>(".mermaid-image")?.src !== old && Boolean(document.querySelector<HTMLImageElement>(".mermaid-image")?.naturalWidth), before);

  const attacks = [
    'flowchart LR\nA[<img src="/probe" onerror="window.__mermaidPwned=1">]',
    '%%{init:{"securityLevel":"loose","themeCSS":"body{display:none}"}}%%\nflowchart LR\nA-->B',
    'flowchart LR\nA-->B; click A href "https://example.com/probe"',
    'flowchart LR\nA@{ img: "https://example.com/probe" }',
    'flowchart LR\nA-->B\nclassDef red fill:red; } body { display:none;',
    'flowchart LR\nA["`![x](/probe)`"]',
    'flowchart LR\nA["&lt;img src=/probe&gt;"]',
    'flowchart LR\nA --> ["unterminated',
  ];
  await page.evaluate((text) => window.mermaidQA.text(text), attacks.map((source) => fence(source)).join("\n\n"));
  await page.waitForFunction((count) => document.querySelectorAll(".mermaid-block .markdown-code").length === count && [...document.querySelectorAll(".mermaid-note")].every((node) => !node.textContent?.includes("Rendering")), attacks.length);
  await page.waitForFunction(() => document.querySelectorAll(".mermaid-render-host").length === 0);
  assert.equal(await page.locator(".mermaid-image").count(), 0);
  assert.equal(await page.evaluate(() => (window as unknown as { __mermaidPwned?: number }).__mermaidPwned), undefined);
  const invalidSvgs = [
    '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="/probe"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import "https://example.com";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><set attributeName="href" to="/probe"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path onload="alert(1)"/></svg>',
    '<?xml-stylesheet href="https://example.com/probe"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>text{fill:u\\72l(https://example.com)}</style></svg>',
  ];
  assert.deepEqual(await page.evaluate((svgs) => svgs.map(window.mermaidQA.validate), invalidSvgs), invalidSvgs.map(() => false));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate((text) => window.mermaidQA.text(text), fence(sources[0]!));
  await page.locator(".mermaid-image").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "phone has no outer horizontal overflow");
  const wide = "flowchart LR\n" + Array.from({ length: 60 }, (_, index) => `N${index}`).join(" --> ");
  assert.ok(await page.evaluate((source) => window.mermaidQA.size(source), wide) > 7_000, "wide fixture needs zoom below five percent on a phone");
  const oldWideUrl = await page.locator(".mermaid-image").getAttribute("src");
  await page.evaluate((text) => window.mermaidQA.text(text), fence(wide));
  await page.waitForFunction((old) => document.querySelector<HTMLImageElement>(".mermaid-image")?.src !== old && Boolean(document.querySelector<HTMLImageElement>(".mermaid-image")?.naturalWidth), oldWideUrl);
  await page.getByRole("button", { name: "Expand diagram", exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Fit diagram", exact: true }).click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await dialog.locator(".mermaid-large-stage").evaluate((stage) => {
    const image = stage.querySelector("img")!;
    return image.getBoundingClientRect().width <= stage.clientWidth && image.getBoundingClientRect().height <= stage.clientHeight;
  }), true, "fit a wide diagram within the mobile stage");
  const wideFit = await dialog.locator(".mermaid-image").evaluate((image) => image.getBoundingClientRect().width);
  await page.keyboard.press("-");
  await page.waitForFunction((before) => document.querySelector(".mermaid-large-stage img")!.getBoundingClientRect().width < before, wideFit);
  await dialog.getByRole("button", { name: "Zoom out", exact: true }).click();
  await page.waitForFunction((before) => document.querySelector(".mermaid-large-stage img")!.getBoundingClientRect().width < before / 1.25, wideFit);
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.keyboard.press("0");
  await page.waitForFunction(() => {
    const stage = document.querySelector<HTMLElement>(".mermaid-large-stage")!;
    return stage.querySelector("img")!.getBoundingClientRect().width <= stage.clientWidth;
  });
  await page.keyboard.press("Escape");
  await page.evaluate((text) => window.mermaidQA.text(text), fence(sources[0]!));
  await page.waitForFunction(() => Boolean(document.querySelector<HTMLImageElement>(".mermaid-image")?.naturalWidth));
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "mermaid-mobile.png") }); }
  await page.locator(".mermaid-block").getByRole("button", { name: "Expand diagram", exact: true }).click();
  await dialog.waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, "mermaid-expanded.png") });
  await dialog.getByRole("button", { name: "Close diagram", exact: true }).click();
  await page.evaluate(() => window.mermaidQA.show(false));
  await page.locator(".mermaid-image").waitFor({ state: "detached" });
  // Every race starts with a fresh module cache and stalls the real lazy renderer request.
  for (const action of ["change", "unmount", "failure"] as const) {
    const race = await context.newPage();
    const raceErrors: string[] = [];
    race.on("pageerror", (error) => raceErrors.push(error.message));
    await race.addInitScript(() => {
      const urls = new Set<string>();
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); urls.add(url); return url; };
      URL.revokeObjectURL = (url) => { urls.delete(url); revoke(url); };
      Object.assign(window, { mermaidLiveUrls: urls });
    });
    let blocked!: () => void;
    const requested = new Promise<void>((resolve) => { blocked = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await race.route(/\/mermaid-[^/]+\.js$/, async (route) => {
      blocked(); await gate;
      if (action === "failure") await route.abort(); else await route.continue();
    });
    await race.goto(origin); await race.getByText("Prose only.").waitFor();
    await race.evaluate((text) => window.mermaidQA.text(text), fence(sources[0]!));
    await Promise.race([requested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("renderer request did not start")), 10_000))]);
    if (action === "change") {
      await race.evaluate((text) => window.mermaidQA.text(text), fence(sources[1]!));
      assert.equal(await race.locator(".mermaid-image").count(), 0);
    } else if (action === "unmount") await race.evaluate(() => window.mermaidQA.show(false));
    release();
    if (action === "change") {
      await race.waitForFunction(() => Boolean(document.querySelector<HTMLImageElement>(".mermaid-image")?.naturalWidth));
      await race.getByRole("button", { name: "Source", exact: true }).click();
      assert.equal(await race.locator("code").textContent(), sources[1]);
    } else if (action === "failure") {
      await race.getByText("Diagram unavailable. Source is shown.", { exact: true }).waitFor();
      assert.equal(await race.locator("code").textContent(), sources[0]);
    } else assert.equal(await race.evaluate((source) => window.mermaidQA.diagnose(source), sources[0]!), "OK");
    await race.evaluate(() => window.mermaidQA.show(false));
    await race.waitForFunction(() => (window as unknown as { mermaidLiveUrls: Set<string> }).mermaidLiveUrls.size === 0 && document.querySelectorAll(".mermaid-render-host").length === 0);
    assert.equal(await race.locator(".mermaid-image").count(), 0);
    assert.deepEqual(raceErrors, []);
    await race.close();
  }
  assert.deepEqual(unexpected, []);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log("mermaid: browser OK (lazy/streaming, four diagrams, source/copy, themes, modal/mobile, rejected resources and output, delayed-source/unmount/import-failure, URL cleanup)");
} finally {
  await browser?.close(); server?.stop(); rmSync(root, { recursive: true, force: true });
}
