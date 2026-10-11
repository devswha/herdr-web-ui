import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// A long press on a pane on a touch screen is the phone's own (select text, copy): it does not
// open the pane menu. A right-click still does. On the unmodified app over the demo's fixture
// transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-touch-long-press-demo-"));

/** Fires a contextmenu on the chat as `pointerType` would, and says whether the page took it. */
const press = (page: Page, pointerType: "touch" | "mouse"): Promise<boolean> => page.locator(".pane-frame.is-current .pane-frame-body").evaluate((body, type) => {
  const target = body.querySelector(".chat-view, .terminal-stack") ?? body;
  const rect = target.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 3, pointerType: type, isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: type === "mouse" ? 2 : 0, buttons: type === "mouse" ? 2 : 1 }));
  target.dispatchEvent(new PointerEvent("pointerup", { ...at, button: type === "mouse" ? 2 : 0, buttons: 0 }));
  const event = new PointerEvent("contextmenu", { ...at, button: 2 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}, pointerType);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
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
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".pane-frame.is-current").waitFor();
      const paneMenu = page.getByRole("dialog", { name: /^Pane actions for / });

      assert.equal(await press(page, "touch"), false, "a touch long press keeps the phone's own selection and copy");
      await page.waitForTimeout(300);
      assert.equal(await paneMenu.count(), 0, "a touch long press opens no pane menu");

      assert.equal(await press(page, "mouse"), true, "a right-click is still the app's");
      await paneMenu.waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a touch long press on a pane is the phone's own, and a right-click still opens the pane menu");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
