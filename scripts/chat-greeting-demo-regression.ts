import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";

// An empty chat's greeting, on the unmodified app over the demo's fixture transport: a workspace
// the demo creates starts with a conversation of no turns. All files and HTTP traffic stay in
// this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-greeting-demo-"));
const LONG_FOLDER = "a-very-long-folder-name-that-never-breaks_with_underscores_and_more_text_2026";

interface Geometry {
  stack: { top: number; bottom: number };
  composer: { top: number; bottom: number };
  greeting: { top: number; bottom: number; left: number; right: number } | null;
  mount: { width: number; height: number };
  transform: string;
  animations: number;
  viewport: number;
  scrollWidth: number;
  overflowing: boolean;
}

const geometryOf = (page: Page): Promise<Geometry> => page.evaluate(() => {
  const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const composer = document.querySelector<HTMLElement>(".composer")!;
  const greeting = document.querySelector(".composer-greeting")?.getBoundingClientRect() ?? null;
  const lines = [...document.querySelectorAll<HTMLElement>(".composer-greeting p")];
  return {
    stack: { top: rect(".terminal-stack").top, bottom: rect(".terminal-stack").bottom },
    composer: { top: rect(".composer").top, bottom: rect(".composer").bottom },
    greeting: greeting && { top: greeting.top, bottom: greeting.bottom, left: greeting.left, right: greeting.right },
    mount: { width: rect(".pane-terminal").width, height: rect(".pane-terminal").height },
    transform: getComputedStyle(composer).transform,
    animations: composer.getAnimations().length,
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: lines.some((line) => line.scrollWidth > line.clientWidth),
  };
});

/** The demo's own "New workspace": an agent pane whose conversation holds no turn yet. */
const newWorkspace = (page: Page, cwd: string): Promise<string> => page.evaluate(async (dir) => {
  const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, agent: { kind: "claude" } }) });
  return ((await response.json()) as { pane_id: string }).pane_id;
}, cwd);

/** The greeting and the composer, as one block, at the stack's vertical centre (the observer that places them answers a frame after a resize). */
const centred = (page: Page): Promise<unknown> => page.waitForFunction(() => {
  const greeting = document.querySelector(".composer-greeting")?.getBoundingClientRect();
  const composer = document.querySelector(".composer")?.getBoundingClientRect();
  const stack = document.querySelector(".terminal-stack")?.getBoundingClientRect();
  return greeting !== undefined && composer !== undefined && stack !== undefined
    && Math.abs((greeting.top + composer.bottom) / 2 - (stack.top + stack.bottom) / 2) <= 2;
}, undefined, { timeout: 5_000 });

const select = async (page: Page, pane: string): Promise<void> => {
  // a phone's drawer rows can be offscreen: dispatch the same row click
  const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
  await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await page.locator(".terminal-stack.is-chat").waitFor();
};

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
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}`;
  const settings = (): void => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); };
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // a mouse-driven window: the greeting and the input card sit at the pane's vertical centre
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      try {
        await desktop.addInitScript(settings);
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".chat-turn").first().waitFor();
        assert.equal(await page.locator(".composer-greeting").count(), 0, "a conversation with turns is not greeted");
        const docked = await geometryOf(page);
        assert.equal(docked.transform, "none");
        console.log("PASS a pane with a conversation keeps its composer docked and shows no greeting");

        const pane = await newWorkspace(page, "/home/demo/new-project");
        await select(page, pane);
        const greeting = page.locator(".composer-greeting");
        // the demo's new agent works for a moment first: it is greeted once it rests
        await greeting.waitFor({ timeout: 8_000 });
        assert.equal(await greeting.locator(".composer-greeting-title").textContent(), "What should Claude do in new-project?");
        assert.equal(await greeting.locator(".composer-greeting-where").textContent(), "workstation · /home/demo/new-project");
        assert.equal(await page.locator(".chat-empty").count(), 0, "the greeting stands in for the chat's own empty line");
        assert.equal(await page.locator(".chat-turn").count(), 0);
        assert.equal(await page.locator(".conn-live").count(), 1);
        await centred(page);
        const lifted = await geometryOf(page);
        assert.ok(lifted.composer.bottom < lifted.stack.bottom - 100, `the composer left the bottom: ${JSON.stringify(lifted)}`);
        assert.ok(Math.abs(lifted.greeting!.bottom - lifted.composer.top) <= 1, "the greeting sits on the composer");
        assert.deepEqual(lifted.mount, docked.mount, "the xterm mount keeps its size under a greeting");
        console.log("PASS an empty chat shows one greeting line, centred with the composer, over an unchanged terminal mount");

        // a draft of several lines grows the box: the pair stays centred
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.fill("one\ntwo\nthree\nfour");
        await page.waitForFunction((before) => document.querySelector(".composer")!.getBoundingClientRect().height > before, lifted.composer.bottom - lifted.composer.top);
        await centred(page);
        await page.setViewportSize({ width: 1000, height: 620 });
        await centred(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await centred(page);
        console.log("PASS the pair stays centred as the draft grows and the window resizes");

        // the first message puts the composer back at the bottom, with no animation
        await message.fill("Start with the README");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await greeting.waitFor({ state: "detached" });
        const sent = await geometryOf(page);
        assert.equal(sent.transform, "none");
        assert.equal(sent.animations, 0, "the composer snaps: nothing animates");
        assert.ok(Math.abs(sent.composer.bottom - sent.stack.bottom) <= 1, `composer docked after the first send: ${JSON.stringify(sent)}`);
        assert.deepEqual(sent.mount, docked.mount, "the xterm mount keeps its size when the greeting goes");
        await page.locator(".chat-turn").first().waitFor({ timeout: 8_000 });
        assert.equal(await page.locator(".composer-greeting").count(), 0);
        assert.deepEqual(errors, []);
        console.log("PASS the first message sent docks the composer at once and the greeting does not return");
      } finally { await desktop.close(); }

      // a phone: the composer stays docked on the keyboard, the greeting above it; long names wrap
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript(settings);
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const pane = await newWorkspace(page, `/home/demo/projects/${LONG_FOLDER}`);
        await select(page, pane);
        await page.locator(".composer-greeting").waitFor({ timeout: 8_000 });
        assert.equal(await page.locator(".composer-greeting-title").textContent(), `What should Claude do in ${LONG_FOLDER}?`);
        const geometry = await geometryOf(page);
        assert.equal(geometry.transform, "none", "a phone does not lift the composer");
        assert.ok(Math.abs(geometry.composer.bottom - geometry.stack.bottom) <= 1, `composer docked on a phone: ${JSON.stringify(geometry)}`);
        assert.ok(Math.abs(geometry.greeting!.bottom - geometry.composer.top) <= 1, "the greeting sits on the composer");
        assert.ok(geometry.greeting!.top >= geometry.stack.top, "the greeting stays inside the pane");
        assert.ok(geometry.greeting!.left >= 0 && geometry.greeting!.right <= geometry.viewport, `greeting inside the screen: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.scrollWidth <= geometry.viewport, "no horizontal page scroll");
        assert.equal(geometry.overflowing, false, "long agent and folder names wrap");
        assert.deepEqual(errors, []);
        console.log("PASS on a phone the greeting sits over the docked composer and a long folder name wraps");
      } finally { await phone.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
