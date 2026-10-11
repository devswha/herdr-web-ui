/** Paging only: the production client over fictional demo transcripts; no live panes. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { appFaces } from "./app-faces.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-pane-paging-demo-"));
// Capture only fictional paging fixtures for PR evidence.
const evidence = process.env.UI_EVIDENCE_DIR;
const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const inputs = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { pagingInputs: unknown[] }).pagingInputs);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.pagingInputs = [];
    window.WebSocket = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (["input", "keys", "submit"].includes(frame.type)) window.pagingInputs.push(frame);
        send(raw);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: Demo[name] });
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n${record}\n<script type="module"`));
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
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const touch of [false, true]) {
        const context = await browser.newContext({ viewport: { width: 1024, height: 600 }, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: "iPad" });
            if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, chatFontSize: 19 }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&view=chat`);
          await page.locator(".conn-live").waitFor();
          await appFaces(page);
          const transcript = page.locator(".pane-frame.is-current .chat-view");
          const composer = page.locator(".pane-frame.is-current .composer-text");
          await composer.waitFor();
          await page.waitForFunction(() => { const node = document.querySelector(".pane-frame.is-current .chat-view")!; return node.scrollHeight > node.clientHeight + 100; });
          await composer.fill("Keep this draft\nand its selection");
          await composer.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 15); });
          const beforeInput = await inputs(page);
          const beforeSelection = await composer.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]);
          for (const rows of [1, 3, 100, 0]) {
            if (rows !== 1) {
              await page.keyboard.press("Meta+Shift+Comma");
              await openSettingsPage(page, "Shortcuts");
              const overlap = page.getByRole("group", { name: "Page overlap", exact: true }).locator("output");
              while (Number(await overlap.textContent()) !== rows) {
                await page.getByRole("button", { name: Number(await overlap.textContent()) < rows ? "Increase page overlap" : "Decrease page overlap", exact: true }).click();
              }
              await page.keyboard.press("Escape");
              await composer.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 15); });
            }
            await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
            await settled(page);
            const bottom = await transcript.evaluate((node) => node.scrollTop);
            const step = await transcript.evaluate((node, rows) => Math.max(1, node.clientHeight - rows * parseFloat(getComputedStyle(node.querySelector(".chat-turn-agent > .markdown, .chat-bubble") ?? node).lineHeight)), rows);
            await page.keyboard.press("Meta+Shift+PageUp");
            // The first frame already has the new position and has stopped following output.
            assert.ok(Math.abs(bottom - await transcript.evaluate((node) => node.scrollTop) - step) <= 1, `chat instantly pages with ${rows} overlap rows`);
            await settled(page);
            assert.ok(Math.abs(bottom - await transcript.evaluate((node) => node.scrollTop) - step) <= 1, "the bottom-pinning effect leaves paged history in place");
            if (rows === 100) {
              await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
              const paged = await transcript.evaluate((node) => node.scrollTop);
              // A height change exercises the chat’s ResizeObserver following path.
              await page.setViewportSize({ width: 1024, height: 580 });
              await settled(page);
              assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - paged) < 0.5, "one-pixel paging remains away through deferred scroll and viewport updates");
              await page.setViewportSize({ width: 1024, height: 600 });
              await settled(page);
            }
            assert.equal(await composer.inputValue(), "Keep this draft\nand its selection");
            assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]), beforeSelection);
            assert.ok(await composer.evaluate((node) => document.activeElement === node), "paging leaves the composer focused");
            if (touch && rows === 1 && evidence) {
              mkdirSync(evidence, { recursive: true });
              await page.screenshot({ path: join(evidence, "ipad-chat-paging.png") });
            }
            await page.keyboard.press("Meta+Shift+PageDown");
            assert.ok(Math.abs(await transcript.evaluate((node) => node.scrollTop) - bottom) <= 1, "opposite page returns to the same bottom");
            if (rows === 100) {
              // The sticky return button participates in scroll height: reach the actual end.
              for (let pages = 0; await transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop > 0); pages++) {
                assert.ok(pages < 128, "one-pixel PageDown reaches the actual bottom within a bounded number of pages");
                await page.keyboard.press("Meta+Shift+PageDown");
                await settled(page);
              }
              await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor({ state: "hidden" });
              await page.setViewportSize({ width: 1024, height: 580 });
              await settled(page);
              assert.ok(await transcript.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 0.5), "PageDown to actual bottom restores following on later viewport updates");
              await page.setViewportSize({ width: 1024, height: 600 });
              await settled(page);
              await transcript.evaluate((node) => { node.scrollTop -= 1; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
              await settled(page);
              assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0, "ordinary manual near-bottom scrolling retains its existing follow tolerance");
            }
          }
          assert.deepEqual(await inputs(page), beforeInput, "paging never sends pane input");
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("u");
          await page.getByRole("combobox", { name: "Scroll pane down", exact: true }).selectOption("d");
          const bottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+U");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), bottom, "a modal blocks pane paging");
          assert.ok(await page.getByRole("dialog", { name: "Settings", exact: true }).evaluate((node) => node.contains(document.activeElement)), "paging cannot move focus out of Settings");
          if (touch && evidence) {
            await page.setViewportSize({ width: 320, height: 760 });
            await page.getByRole("group", { name: "Page overlap", exact: true }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(evidence, "page-overlap-phone.png") });
            assert.ok(await page.locator(".settings-body:not([hidden])").evaluate((node) => node.scrollWidth <= node.clientWidth), "paging settings fit a narrow phone");
            await page.setViewportSize({ width: 1024, height: 600 });
          }
          await page.keyboard.press("Escape");
          await composer.focus();
          await page.keyboard.press("Meta+Shift+U");
          assert.ok(await transcript.evaluate((node) => node.scrollTop) < bottom - 50, "letter overrides page without dedicated iPad PageUp keys");
          await page.keyboard.press("Meta+Shift+D");
          await page.reload();
          await page.locator(".conn-live").waitFor();
          await composer.waitFor();
          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          assert.equal(await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).inputValue(), "u", "paging overrides survive reload");
          assert.equal(await page.getByRole("group", { name: "Page overlap", exact: true }).locator("output").textContent(), "0", "overlap survives reload");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("off");
          await page.keyboard.press("Escape");
          await composer.focus();
          await transcript.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          const disabledBottom = await transcript.evaluate((node) => node.scrollTop);
          await page.keyboard.press("Meta+Shift+PageUp");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), disabledBottom, "disabled paging restores the key to the focused control");

          await page.keyboard.press("Meta+Shift+Comma");
          await openSettingsPage(page, "Shortcuts");
          await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("default");
          await page.keyboard.press("Escape");
          await transcript.evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
          await settled(page);
          await page.keyboard.press("Meta+Shift+PageUp");
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollTop), 0, "PageUp at the history start has no movement");
          assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 1, "unavailable upward movement leaves the reader away");
          await transcript.evaluate((node) => { (node.firstElementChild as HTMLElement).style.display = "none"; node.scrollTop = 0; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
          await settled(page);
          assert.equal(await transcript.evaluate((node) => node.scrollHeight > node.clientHeight), false, "the fixture now has no scrollable history");
          await page.keyboard.press("Meta+Shift+PageUp");
          await page.keyboard.press("Meta+Shift+D");
          await settled(page);
          assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0, "paging without available movement does not mark the chat away");
          assert.deepEqual(errors, []);
          console.log(`PASS pane paging: ${touch ? "iPad keyboard" : "desktop"}, overlap, caret, selection, modal gate, override, reload`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
