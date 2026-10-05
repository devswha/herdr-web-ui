import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

// The late arrival of the app's faces (src/fonts/fonts.css, font-display: swap), on the unmodified
// app over the demo's fixture transport: the font files are held back here as a slow link holds
// them, so the conversation is first drawn in this machine's fallback and rewraps when a face
// comes. Each case holds them until it has measured that first drawing and then lets them go, so
// no clock decides which drawing was measured. All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session
// is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-font-swap-demo-"));

interface View { top: number; gap: number; height: number }
const viewOf = (page: Page): Promise<View> => page.evaluate(() => {
  const node = document.querySelector<HTMLElement>(".chat-view")!;
  return { top: node.scrollTop, gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), height: node.scrollHeight };
});
const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const loadedFaces = (page: Page, family: string): Promise<number> => page.evaluate((name) => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === name && face.status === "loaded").length, family);

try {
  const build = Bun.spawnSync([join(repo, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo });
  assert.equal(build.exitCode, 0, new TextDecoder().decode(build.stderr));
  const transport = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app,
    naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
  });
  assert.ok(transport.success, transport.logs.map(String).join("\n"));
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  // fonts.css takes an installed JetBrains Mono before the file; a request this script holds must
  // be the only way to the face, on a developer's desktop that has the font as on CI that has not
  let fileOnly = 0;
  for (const name of readdirSync(join(app, "assets")).filter((entry) => entry.endsWith(".css"))) {
    const css = readFileSync(join(app, "assets", name), "utf8");
    const stripped = css.replace(/local\((?:"[^"]*"|'[^']*'|[^)]*)\)\s*,\s*/g, () => { fileOnly += 1; return ""; });
    if (stripped !== css) writeFileSync(join(app, "assets", name), stripped);
  }
  assert.ok(fileOnly > 0, "the built stylesheet names an installed face, and this copy of it no longer does");

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      /** A phone on a slow link: every font file is held until `release`. `stall` names files that never come at all. */
      const open = async (stall: RegExp | null, height = 844): Promise<{ page: Page; errors: string[]; held: () => number; release: () => void; close: () => Promise<void> }> => {
        const context = await browser.newContext({ viewport: { width: 390, height }, locale: "en-US", hasTouch: true, isMobile: true });
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let asked = 0;
        let release = (): void => undefined;
        const released = new Promise<void>((done) => { release = done; });
        await page.route("**/*.woff2", async (route) => {
          asked += 1;
          if (stall !== null && stall.test(route.request().url())) return;
          await released;
          await route.continue().catch(() => undefined);
        });
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        await page.locator(".chat-turn").first().waitFor();
        await frames(page);
        return { page, errors, held: () => asked, release, close: () => { release(); return context.close(); } };
      };

      {
        const { page, errors, held, release, close } = await open(null);
        try {
          assert.ok(held() > 0, "the first drawing asked for a face");
          assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "the conversation is first drawn before the face comes");
          assert.equal(await loadedFaces(page, "JetBrains Mono Web"), 0, "and before the code face comes");
          const before = await viewOf(page);
          assert.ok(before.height > 0 && before.gap <= 1, `an opened conversation is at its end (gap ${before.gap})`);
          release();
          await appFaces(page);
          const after = await viewOf(page);
          assert.ok(after.gap <= 1, `a reader at the end is still there after the faces came (gap ${after.gap}, height ${before.height} -> ${after.height})`);
          assert.deepEqual(errors, []);
          console.log(`PASS a reader at the end stays at the end when the faces swap in (height ${before.height} -> ${after.height})`);
        } finally { await close(); }
      }

      {
        // one file never comes: the set's "loadingdone" does not fire, and the face that did come still counts
        const { page, errors, release, close } = await open(/JetBrainsMono/);
        try {
          assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "the conversation is first drawn before the face comes");
          const before = await viewOf(page);
          assert.ok(before.gap <= 1, `an opened conversation is at its end (gap ${before.gap})`);
          release();
          await page.waitForFunction(() => [...document.fonts].some((face) => face.family.replace(/["']/g, "") === "Pretendard Variable" && face.status === "loaded"), null, { timeout: 10_000 });
          await frames(page);
          assert.equal(await page.evaluate(() => document.fonts.status), "loading", "another face is still on its way");
          assert.equal(await loadedFaces(page, "JetBrains Mono Web"), 0);
          const after = await viewOf(page);
          assert.ok(after.gap <= 1, `a face that came is followed while another is still on its way (gap ${after.gap}, height ${before.height} -> ${after.height})`);
          assert.deepEqual(errors, []);
          console.log(`PASS a face that arrived is followed while another file is still in flight (height ${before.height} -> ${after.height})`);
        } finally { await close(); }
      }

      {
        // a short window, so that the top of this conversation is well away from its end
        const { page, errors, release, close } = await open(null, 480);
        try {
          await page.evaluate(() => { document.querySelector(".chat-view")!.scrollTop = 0; });
          await frames(page);
          const up = await viewOf(page);
          assert.ok(up.top === 0 && up.gap > 48, `the reader is away from the end (gap ${up.gap})`);
          assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "and reads the first drawing, before the face comes");
          release();
          await appFaces(page);
          const after = await viewOf(page);
          assert.equal(after.top, 0, "a reader who scrolled up is left where they read");
          assert.ok(after.gap > 48, "and that was away from the end");
          assert.deepEqual(errors, []);
          console.log("PASS a reader who scrolled up is not pulled to the end when the faces swap in");
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
