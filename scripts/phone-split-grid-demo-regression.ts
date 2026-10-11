import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// A phone shows a split tab one pane at a time and keeps the others mounted behind it (#819). The
// pty is shared with every device, so a hidden pane must not size it: a PC drawing the split would
// see that pane at the phone's size. Shown again, the pane fits the phone and takes the pty. On the
// unmodified app over the demo's fixture transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-phone-split-grid-demo-"));

interface Frame { type: string; pane_id: string; cols?: number; keep_size?: boolean }
const frames = (page: Page, pane: string): Promise<Frame[]> =>
  page.evaluate((id) => (window as unknown as { sent: Frame[] }).sent.filter((frame) => frame.pane_id === id), pane);

const layout = async (page: Page, path: string, body: Record<string, unknown>): Promise<{ pane?: { pane_id?: string } }> => {
  const [status, json] = await page.evaluate(async ([url, payload]) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    return [response.status, await response.json().catch(() => ({}))] as const;
  }, [path, JSON.stringify(body)] as const);
  assert.equal(status, 200, `${path} answered ${status}`);
  return json as { pane?: { pane_id?: string } };
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // the demo's socket is a class of its own that no browser event reports: note every frame it sends
  const record = `<script>(() => {
    const Demo = window.WebSocket;
    window.sent = [];
    const Recorded = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "resize" || frame.type === "attach") window.sent.push(frame); }
        send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Recorded, name, { value: Demo[name] });
    window.WebSocket = Recorded;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => {
        if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "terminal" }));
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const made = await layout(page, "/api/pane/split", { pane_id: panes.shell, direction: "right", focus: true });
      assert.ok(made.pane?.pane_id, JSON.stringify(made));
      await page.locator(".pane-frame.is-hidden").waitFor({ state: "attached" });
      // the split tab shows one pane on the phone, the other mounted behind it; the phone turns
      const shell = await page.locator(".pane-frame.is-hidden").getAttribute("data-layout-pane") as string;
      const sibling = await page.locator(".pane-frame:not(.is-hidden)").getAttribute("data-layout-pane") as string;
      await page.locator(`.pane-frame:not(.is-hidden)[data-layout-pane="${sibling}"] .xterm-rows`).waitFor();
      await page.waitForTimeout(1_000);
      await page.evaluate(() => { (window as unknown as { sent: Frame[] }).sent = []; });
      await page.setViewportSize({ width: 700, height: 390 });
      await page.waitForFunction((id) => (window as unknown as { sent: Frame[] }).sent.some((frame) => frame.pane_id === id && frame.type === "resize"), sibling, { timeout: 10_000 });
      await page.waitForTimeout(1_000);
      assert.deepEqual(await frames(page, shell), [], "the hidden pane sends no resize");

      // turned back (a short screen draws no strip for a lone tab), the tab's menu leads to the shell
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction((id) => (window as unknown as { sent: Frame[] }).sent.filter((frame) => frame.pane_id === id && frame.type === "resize").at(-1)?.cols! < 60, sibling, { timeout: 10_000 });
      await page.waitForTimeout(1_000);
      assert.deepEqual(await frames(page, shell), [], "the hidden pane still sends no resize");
      const phoneCols = (await frames(page, sibling)).filter((frame) => frame.type === "resize").at(-1)!.cols!;

      // shown again, the shell fits the phone and takes the pty
      await page.locator(".tab-strip-menu:visible").tap();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      await sheet.locator('.row-sheet-item:not([aria-current="true"])').first().tap();
      await page.locator(`.pane-frame:not(.is-hidden)[data-layout-pane="${shell}"]`).waitFor();
      await page.waitForFunction((id) => (window as unknown as { sent: Frame[] }).sent.some((frame) => frame.pane_id === id && frame.type === "resize"), shell, { timeout: 10_000 });
      const taken = (await frames(page, shell)).filter((frame) => frame.type === "resize").at(-1)!;
      assert.equal(taken.cols, phoneCols, "the pane shown again takes the pty at the phone's size");
      assert.deepEqual(errors, []);
      console.log(`PASS a phone's hidden split pane sizes nothing, and takes the pty (${phoneCols} columns) once shown`);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
