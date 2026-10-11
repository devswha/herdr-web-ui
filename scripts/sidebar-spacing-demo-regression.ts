/**
 * Purpose: verify sidebar spacing when PC groups fold in a real browser.
 * Tags: sidebar, spacing, responsive, browser, regression.
 * Usage: bun scripts/sidebar-spacing-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-spacing-demo-"));
const spacing = 16;

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });

  for (const mobile of [false, true]) {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
        locale: "en-US",
      });
      await context.addInitScript(() => localStorage.removeItem("herdr-web-ui:pc-collapsed:local"));
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (mobile) await page.locator(".drawer-toggle").tap();
      const machineToggle = page.locator(".machine-toggle").first();
      const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
      await machineToggle.waitFor();
      if (await agentToggle.getAttribute("aria-expanded") !== "true") await agentToggle.click();
      const before = await page.locator(".agents-sidebar .agent-title").allTextContents();
      assert.ok(before.length > 0, `${mobile ? "mobile" : "desktop"} has agent rows before folding`);
      assert.equal(await machineToggle.getAttribute("aria-expanded"), "true");

      await machineToggle.click();
      await page.waitForFunction(() => !document.querySelector(".machine-workspaces"));
      const metrics = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        const shell = box(".sidebar-shell")!;
        const machine = box(".machine-group")!;
        const list = box(".machine-list")!;
        const agents = box(".agents-sidebar")!;
        const contents = document.querySelector<HTMLElement>(".agent-list-contents")!;
        const footer = box(".sidebar-footer")!;
        return {
          shellHeight: shell.height,
          machineBottom: machine.bottom,
          listBottom: list.bottom,
          agentsTop: agents.top,
          agentsHeight: agents.height,
          contentsOverflow: getComputedStyle(contents).overflowY,
          footerBottom: footer.bottom,
          shellBottom: shell.bottom,
        };
      });
      assert.ok(metrics.agentsTop - metrics.machineBottom <= spacing, `${mobile ? "mobile" : "desktop"} folded PC gap is ${metrics.agentsTop - metrics.machineBottom}px`);
      assert.ok(metrics.listBottom - metrics.machineBottom <= spacing, `${mobile ? "mobile" : "desktop"} folded list padding is ${metrics.listBottom - metrics.machineBottom}px`);
      assert.ok(metrics.agentsHeight <= metrics.shellHeight / 2 + 1, `${mobile ? "mobile" : "desktop"} Agents keeps its half-sidebar cap`);
      assert.equal(metrics.contentsOverflow, "auto", `${mobile ? "mobile" : "desktop"} Agents keeps scroll ownership`);
      assert.equal(Math.round(metrics.footerBottom), Math.round(metrics.shellBottom), `${mobile ? "mobile" : "desktop"} footer stays at the bottom`);
      assert.deepEqual(await page.locator(".agents-sidebar .agent-title").allTextContents(), before, `${mobile ? "mobile" : "desktop"} agent order is unchanged`);

      await agentToggle.click();
      assert.equal(await agentToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator(".agent-list-contents").getAttribute("hidden"), "");
      console.log(`PASS ${mobile ? "390px" : "desktop"} sidebar spacing after folding the PC section`);
      await context.close();
    } finally {
      await browser.close();
    }
  }
  server.stop(true);
} finally {
  rmSync(app, { recursive: true, force: true });
}
