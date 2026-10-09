/**
 * Deterministic real-client regression on fictional demo PCs. No herdr or user config is opened.
 * Every DOM wait is bounded; demo startup transitions are held before the client loads.
 * Run: UI_EVIDENCE_DIR=evidence/workspace-layout CHROME_PATH=... bun scripts/workspace-layout-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import panes from "../site/demo/fixtures/panes.json";

const app = mkdtempSync(join(tmpdir(), "herdr-layout-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR ?? join(import.meta.dir, "../evidence/workspace-layout");
mkdirSync(evidence, { recursive: true });
const presets = ["auto", "2-columns", "3-columns", "4-columns", "2x2", "3x2"];
const visible = (page: Page) => page.locator(".dock-cell:visible");
const cell = (page: Page, id: string, machine = "local") => page.locator(`.dock-cell[data-pane-id="${id}"][data-machine-id="${machine}"]`);
async function drag(page: Page, source: Locator, target: Locator, edge: "left" | "right" | "up" | "down") {
  const box = await target.boundingBox();
  assert.ok(box);
  await source.scrollIntoViewIfNeeded();
  const data = await page.evaluateHandle(() => new DataTransfer());
  try {
    await source.dispatchEvent("dragstart", { dataTransfer: data });
    const point = {
      clientX: box.x + box.width * (edge === "left" ? 0.1 : edge === "right" ? 0.9 : 0.5),
      clientY: box.y + box.height * (edge === "up" ? 0.1 : edge === "down" ? 0.9 : 0.5),
    };
    await target.dispatchEvent("dragover", { dataTransfer: data, ...point });
    await page.locator(".dock-drop-preview").waitFor();
    await target.dispatchEvent("drop", { dataTransfer: data, ...point });
    await source.dispatchEvent("dragend", { dataTransfer: data });
    await page.locator(".dock-drop-preview").waitFor({ state: "detached" });
  } finally { await data.dispose(); }
}
async function shortcut(page: Page, key: string, extra: object = {}) {
  if (Object.keys(extra).length === 0) {
    await page.keyboard.press(`ControlOrMeta+Shift+${key}`);
    return;
  }
  await page.evaluate(({ key, extra }) => {
    const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
    window.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, metaKey: mac, ctrlKey: !mac, shiftKey: true, bubbles: true, cancelable: true, ...extra }));
  }, { key, extra });
}
const identity = (page: Page) => page.locator(".dock-cell").evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
  node.getAttribute("data-dock-key"), [node.getAttribute("data-session-number"), getComputedStyle(node).getPropertyValue("--session-color")],
])));

try {
  await buildDemoApp(app);
  const fixture = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/workspace-layout.ts")], outdir: app, naming: "layout-fixture.js", target: "browser" });
  assert.ok(fixture.success, fixture.logs.map(String).join("\n"));
  const html = readFileSync(join(app, "index.html"), "utf8").replace(/<script type="module"/,
    `<script>window.layoutDemoTimers=[];window.layoutDemoTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>{window.layoutDemoTimers.push(()=>fn(...args));return -1;};</script>
<script src="./demo-transport.js"></script>
<script>window.setTimeout=window.layoutDemoTimeout;</script>
<script src="./layout-fixture.js"></script>
<script type="module"`);
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    const file = decodeURIComponent(path.slice(prefix.length)) || "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("invalid path", { status: 400 });
    if (file === "index.html") return new Response(html, { headers: { "content-type": "text/html" } });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true });
    // A closed browser rejects any pending driver command and enters the cleanup below.
    const deadline = setTimeout(() => { void browser.close(); }, 180_000);
    try {
      for (const theme of ["dark", "light"]) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", reducedMotion: "reduce" });
        try {
          await context.addInitScript(({ theme }) => {
            localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme, defaultView: "chat", usageEnabled: false }));
          }, { theme });
          const page = await context.newPage();
          page.setDefaultTimeout(8000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".composer-text").waitFor();
          await page.locator(".header-more-button").click();
          await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
          await page.locator(".split-cell").nth(1).waitFor();
          assert.equal(await page.locator(".split-cell").count(), 2);
          await page.locator(".split-cell").nth(1).getByRole("button", { name: "Chat", exact: true }).click();
          await page.locator(".split-cell").nth(1).locator(".chat-turn").first().waitFor();
          assert.equal(await page.locator(".split-cell .chat-inline-error").count(), 0, "new demo shell panes have a readable chat fallback");
          const nativeNodes = await page.locator(".split-cell").elementHandles();
          await page.locator(".split-cell.is-active").getByRole("button", { name: "Zoom pane", exact: true }).click();
          await page.locator('.split-cell.is-active button[aria-label="Zoom pane"][aria-pressed="true"]').waitFor();
          assert.equal(await page.locator(".split-cell:visible").count(), 1);
          await shortcut(page, "e");
          await page.locator('.split-cell.is-active button[aria-label="Zoom pane"][aria-pressed="false"]').waitFor();
          for (const node of nativeNodes) { assert.ok(await node.evaluate((element) => element.isConnected)); await node.dispose(); }
          const nativeDivider = page.locator(".split-divider").first();
          const ratio = Number(await nativeDivider.getAttribute("aria-valuenow"));
          await nativeDivider.focus(); await nativeDivider.press("ArrowRight");
          await page.locator(`.split-divider[aria-valuenow="${ratio + 5}"]`).waitFor();
          await page.screenshot({ path: join(evidence, `native-1440-${theme}.png`) });
          const row = (id: string) => page.locator(`.workspace-select[data-pane="${id}"]`);
          await drag(page, row(panes.web), page.locator(".split-cell").first(), "left");
          await visible(page).nth(2).waitFor();
          await drag(page, row(panes.infra), cell(page, panes.web), "down");
          await visible(page).nth(3).waitFor();
          assert.equal(await visible(page).count(), 4);
          const identities = await identity(page);
          const nodes = await page.locator(".dock-cell").elementHandles();
          // The real pending-input demo accepts one queue ID. Rearranging must not submit it twice.
          await page.getByRole("button", { name: "All chat", exact: true }).click();
          const api = cell(page, panes.api);
          await api.locator(".composer-text").fill("Hold this layout regression message");
          await api.locator(".composer-text").press("Enter");
          await api.locator('.pending-message[data-state="queued"]').waitFor();
          const beforeLayoutInput = await page.evaluate(() => (window as unknown as { layoutFixture: { frames: { type: string }[] } }).layoutFixture.frames.filter((frame) =>
            ["submit", "input", "keys", "pending-action"].includes(frame.type)).length);
          for (const preset of presets) {
            await page.locator(`[data-layout-preset="${preset}"]`).click();
            assert.equal(await visible(page).count(), 4);
            assert.deepEqual(await identity(page), identities);
            for (const node of nodes) assert.ok(await node.evaluate((element) => element.isConnected), "presets keep live connections mounted");
            await api.locator('.pending-message[data-state="queued"]').waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            await page.screenshot({ path: join(evidence, `preset-${preset}-1440-${theme}.png`) });
          }
          await page.getByRole("button", { name: "All terminal", exact: true }).click();
          await api.getByRole("button", { name: "Maximize this view", exact: true }).click();
          assert.equal(await visible(page).count(), 1);
          await page.getByRole("button", { name: "All chat", exact: true }).click();
          assert.equal(await api.locator('.dock-cell-view button[aria-pressed="true"]').getAttribute("title"), "Chat");
          for (const other of await page.locator('.dock-cell:not(.is-active)').all()) {
            assert.equal(await other.locator('.dock-cell-view button[aria-pressed="true"]').getAttribute("title"), "Terminal");
          }
          await shortcut(page, "e", { repeat: true });
          assert.equal(await visible(page).count(), 1);
          await shortcut(page, "e", { isComposing: true });
          assert.equal(await visible(page).count(), 1);
          await shortcut(page, "e");
          await visible(page).nth(3).waitFor();
          await api.locator('.pending-message[data-state="queued"]').waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { layoutFixture: { frames: { type: string }[] } }).layoutFixture.frames.filter((frame) =>
            ["submit", "input", "keys", "pending-action"].includes(frame.type)).length), beforeLayoutInput, "layout changes never send or replay input");
          for (const node of nodes) { assert.ok(await node.evaluate((element) => element.isConnected)); await node.dispose(); }
          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator(".dock-tabs").waitFor();
          assert.equal(await visible(page).count(), 1);
          assert.equal(await page.locator(".dock-tabs button").count(), 4);
          await page.screenshot({ path: join(evidence, `dock-390-${theme}.png`) });
          await page.setViewportSize({ width: 1440, height: 1000 });
          await visible(page).nth(3).waitFor();
          await api.locator(".pending-message").getByRole("button", { name: "Discard", exact: true }).click();
          await api.locator(".pending-message").waitFor({ state: "detached" });
          const countBeforeClose = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.panes.length);
          await api.getByRole("button", { name: "Close view only — keep the session running", exact: true }).click();
          await api.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.panes.length), countBeforeClose);
          assert.deepEqual(errors, []);
          console.log(`PASS ${theme}: native split/resize/zoom, directional docking, six presets, stable mounts/badges, pending ownership, visible-only lenses, mobile, close-view`);
        } finally { await context.close(); }
      }
      // Native split PC changes must replace sockets even when both PCs reuse pane IDs.
      const nativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
      try {
        await nativeContext.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({
          language: "en", defaultView: "chat",
        })));
        const page = await nativeContext.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?remote=1&native=1&pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".composer-text").waitFor();
        await page.locator(".header-more-button").click();
        await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
        await page.locator(".split-cell").nth(1).waitFor();
        const oldNodes = await page.locator(".split-cell").elementHandles();
        const inputCount = () => page.evaluate(() => {
          const fixture = Reflect.get(window, "layoutFixture");
          return fixture.frames.filter((frame: { type: string }) => ["submit", "input", "keys", "pending-action"].includes(frame.type)).length;
        });
        const before = await inputCount();
        const attached = page.waitForEvent("console", { predicate: (message) =>
          message.text() === `layout-frame:qa-remote:attach:${panes.api}`, timeout: 8000 });
        await page.locator('.agent-item[data-machine="qa-remote"]').first().click();
        await attached;
        for (const node of oldNodes) {
          assert.equal(await node.evaluate((element) => element.isConnected), false, "native PC switch remounts terminals");
          await node.dispose();
        }
        assert.equal(await inputCount(), before, "PC switching never replays input");
        const frames = await page.evaluate(() => Reflect.get(window, "layoutFixture").frames);
        assert.ok(frames.filter((frame: { machine: string; type: string }) => frame.machine === "local" && frame.type === "close").length >= 2);
        const target = page.locator(".split-cell.is-active");
        await target.getByRole("button", { name: "Chat", exact: true }).click();
        await target.locator(".composer-text").fill("Native remote destination regression");
        const submitted = page.waitForEvent("console", { predicate: (message) =>
          message.text() === `layout-frame:qa-remote:submit:${panes.api}`, timeout: 8000 });
        await target.locator(".composer-text").press("Enter");
        await submitted;
        assert.equal(await inputCount(), before + 1, "only the explicitly selected remote PC receives input");
        console.log("PASS native split duplicate IDs: local sockets closed, remote attached, no replay, exact remote submit");
      } finally { await nativeContext.close(); }
      // Same pane ID on two PCs: identities, storage, requests and sockets must stay distinct.
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
      try {
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({
          language: "en", defaultView: "chat", shortcutOverrides: { palette: "e", "zoom-view": "q" },
        })));
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?remote=1&pane=${encodeURIComponent(panes.api)}`);
        await page.getByRole("button", { name: /^Running / }).click();
        await visible(page).first().waitFor();
        await page.getByRole("button", { name: /^All / }).filter({ hasNot: page.locator("svg") }).first().click();
        await cell(page, panes.api, "qa-remote").waitFor();
        assert.notEqual(await cell(page, panes.api).getAttribute("data-session-number"), await cell(page, panes.api, "qa-remote").getAttribute("data-session-number"));
        await cell(page, panes.api, "qa-remote").locator(".dock-cell-title").click();
        await shortcut(page, "e");
        await page.getByRole("dialog").waitFor();
        assert.ok(await visible(page).count() > 1, "upstream custom palette owns E");
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "detached" });
        await shortcut(page, "q");
        assert.equal(await visible(page).count(), 1);
        await shortcut(page, "q");
        const remoteRow = page.locator('.agent-item[data-machine="qa-remote"]').first();
        await remoteRow.locator(".agent-place").click();
        await page.locator("dialog.dock-placement").waitFor();
        await page.keyboard.press("Escape");
        await page.locator("dialog.dock-placement").waitFor({ state: "detached" });
        assert.ok(await remoteRow.locator(".agent-place").evaluate((element) => element === document.activeElement));
        await drag(page, cell(page, panes.api, "qa-remote").locator(".dock-cell-title"), cell(page, panes.api), "up");
        const calls = await page.evaluate(() => {
          const fixture = (window as unknown as { layoutFixture: { requests: { path: string }[]; frames: { type: string; machine: string }[] } }).layoutFixture;
          return { requests: fixture.requests, frames: fixture.frames };
        });
        assert.ok(calls.requests.some((call) => call.path === "/api/machines/qa-remote/pane/conversation"));
        assert.ok(calls.frames.some((frame) => frame.type === "connect" && frame.machine === "qa-remote"));
        await page.screenshot({ path: join(evidence, "cross-pc-1440-dark.png") });
        console.log("PASS remote duplicate IDs, captured API/socket ownership, custom shortcut ownership, keyboard placement cancellation and cross-PC directional drag");
      } finally { await context.close(); }
    } finally { clearTimeout(deadline); await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
