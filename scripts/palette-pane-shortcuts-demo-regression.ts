/** Keyboard-only input focus on the real client against fictional demo panes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import panes from "../site/demo/fixtures/panes.json";

const app = mkdtempSync(join(tmpdir(), "herdr-palette-shortcuts-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
    try {
      for (const custom of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 1024, height: 700 }, locale: "en-US" });
        try {
          await context.addInitScript(({ custom }) => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
            localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false,
              shortcutOverrides: custom ? { "previous-pane": "1", "next-pane": "2" } : {} }));
          }, { custom });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&view=chat`);
          await page.locator(".conn-live").waitFor();
          const selected = () => page.locator(".pane-frame.is-current").getAttribute("data-layout-pane");
          const before = await selected();
          await page.keyboard.press("Meta+Shift+K");
          const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
          const search = palette.getByRole("searchbox");
          await search.waitFor();
          await search.fill("API");
          await search.dispatchEvent("keydown", { key: "ArrowDown", code: "ArrowDown", metaKey: true, shiftKey: true, isComposing: true, bubbles: true });
          assert.equal(await palette.locator('.palette-filter[data-status="all"]').getAttribute("aria-checked"), "true", "IME keeps ownership of its keys");
          const next = custom ? "Meta+Shift+Digit2" : "Meta+Shift+ArrowDown";
          const previous = custom ? "Meta+Shift+Digit1" : "Meta+Shift+ArrowUp";
          for (const status of ["blocked", "working", "idle", "done", "waiting", "all"]) {
            await page.keyboard.press(next);
            await page.waitForFunction(status => document.querySelector(`.palette-filter[data-status="${status}"]`)?.getAttribute("aria-checked") === "true", status);
            assert.equal(await selected(), before, "filter navigation leaves the background pane alone");
            assert.equal(await search.inputValue(), "API", "query survives navigation");
            assert.equal(await search.evaluate(node => node === document.activeElement), true, "search keeps focus");
          }
          await page.keyboard.press(previous);
          assert.equal(await palette.locator('.palette-filter[data-status="waiting"]').getAttribute("aria-checked"), "true", "previous wraps from All to BG");
          await palette.locator('.palette-filter[data-status="waiting"]').focus();
          await page.keyboard.press(next);
          assert.equal(await palette.locator('.palette-filter[data-status="all"]').getAttribute("aria-checked"), "true", "navigation also works with filter focus");
          await search.focus();
          await search.fill("");
          await page.keyboard.press(next);
          assert.equal(await palette.locator('.palette-filter[data-status="blocked"]').getAttribute("aria-checked"), "true", "empty search navigates filters too");
          assert.equal(await selected(), before);
          await search.fill(">settings");
          await page.keyboard.press(next);
          assert.equal(await selected(), before, "actions-only mode never navigates the background");
          await page.keyboard.press("Escape");
          await page.locator(".pane-frame.is-current").focus();
          await page.keyboard.press(next);
          await page.waitForFunction(before => document.querySelector(".pane-frame.is-current")?.getAttribute("data-layout-pane") !== before, before);
          console.log(`PASS palette pane shortcuts: ${custom ? "custom" : "default"}, wrapping, search/focus, background isolation and close`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
