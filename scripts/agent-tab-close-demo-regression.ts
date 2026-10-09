import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// An agent row's right-click menu closes the agent's tab, on the unmodified app over the demo's
// fixture transport (site/demo/transport.ts), whose /api/tab/close drops the tab, its panes and a
// workspace left without tabs. Every demo workspace starts with one tab; a second one is made
// with the demo's /api/tab/create, whose agent works for 1.5s and then waits. All files and HTTP
// traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-agent-tab-close-demo-"));

const API = "Idempotent payments"; // claude in checkout-api, the workspace's one tab

const agentRow = (page: Page, paneId: string) => page.locator(`.agents-sidebar .agent-item[data-pane="${paneId}"] .agent-select`);
const workspaceOf = (paneId: string) => paneId.split(":")[0]!;
const workspaceRow = (page: Page, workspaceId: string) => page.locator(`.machine-workspaces .workspace-group[data-workspace="${workspaceId}"]`);
const menu = (page: Page) => page.locator(".row-menu");
const dialog = (page: Page) => page.locator(".confirm-dialog");

async function withPage(browser: Browser, run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat" }));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen: the tabs closed here are never the open one
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await agentRow(page, panes.api).waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      await withPage(browser, async (page) => {
        // a right-click opens the row's menu, named by the agent, with Close tab; Escape closes it
        // and gives the focus back to the row
        await agentRow(page, panes.api).click({ button: "right" });
        await menu(page).waitFor();
        assert.equal(await menu(page).getAttribute("aria-label"), API);
        assert.deepEqual(await menu(page).getByRole("menuitem").allTextContents(), ["Close tab"]);
        await page.keyboard.press("Escape");
        await menu(page).waitFor({ state: "detached" });
        assert.equal(await agentRow(page, panes.api).evaluate((row) => row === document.activeElement), true, "the focus goes back to the row");
        // the keyboard's menu key opens it too, on the focused row
        await agentRow(page, panes.api).press("Shift+F10");
        await menu(page).waitFor();
        await page.keyboard.press("Escape");
        await menu(page).waitFor({ state: "detached" });
      });
      console.log("PASS a right-click or Shift+F10 on an agent row opens its Close tab menu, and Escape closes it");

      await withPage(browser, async (page) => {
        // a second tab whose agent is not at work closes at once, and its workspace stays
        const made = await page.evaluate(async (workspace_id) => {
          const response = await fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id, agent: { kind: "claude" } }) });
          return (await response.json()) as { pane_id: string };
        }, workspaceOf(panes.infra));
        await agentRow(page, made.pane_id).waitFor();
        await page.locator(`.agents-sidebar .agent-item[data-pane="${made.pane_id}"] .sidebar-status[data-status="idle"]`).waitFor({ timeout: 10_000 });
        await agentRow(page, made.pane_id).click({ button: "right" });
        await menu(page).getByRole("menuitem", { name: "Close tab" }).click();
        await agentRow(page, made.pane_id).waitFor({ state: "detached", timeout: 5_000 });
        assert.equal(await dialog(page).count(), 0, "an idle agent's tab beside another closes without a question");
        await agentRow(page, panes.infra).waitFor();
        assert.equal(await workspaceRow(page, workspaceOf(panes.infra)).count(), 1, "the workspace keeps its other tab");
        // the row went with its tab: the focus lands on the header's workspace-list toggle
        await page.waitForFunction(() => document.activeElement?.matches(".app-header .drawer-toggle, .app-header .sidebar-toggle") === true, undefined, { timeout: 5_000 });
      });
      console.log("PASS an idle agent's tab beside another closes at once from its row, and its workspace stays");

      await withPage(browser, async (page) => {
        // the workspace's last tab asks first; Cancel keeps it, Close tab takes the workspace too
        const ask = async (): Promise<void> => {
          await agentRow(page, panes.api).click({ button: "right" });
          await menu(page).getByRole("menuitem", { name: "Close tab" }).click();
          await dialog(page).waitFor();
        };
        await ask();
        // a tab herdr names by its place is named by the agent's row, not "Tab 1"
        assert.equal(await dialog(page).locator(".modal-title").textContent(), `Close tab ${API}?`);
        assert.match(await dialog(page).locator(".confirm-body").textContent() ?? "", /last tab of checkout-api/);
        await dialog(page).getByRole("button", { name: "Cancel" }).click();
        await dialog(page).waitFor({ state: "detached" });
        assert.equal(await agentRow(page, panes.api).count(), 1, "Cancel closes nothing");
        assert.equal(await agentRow(page, panes.api).evaluate((row) => row === document.activeElement), true, "Cancel gives the focus back to the row");

        await ask();
        await dialog(page).getByRole("button", { name: "Close tab" }).click();
        await dialog(page).waitFor({ state: "detached", timeout: 5_000 });
        await agentRow(page, panes.api).waitFor({ state: "detached", timeout: 5_000 });
        await workspaceRow(page, workspaceOf(panes.api)).waitFor({ state: "detached", timeout: 5_000 });
        await agentRow(page, panes.web).waitFor();
      });
      console.log("PASS the last tab's close asks first; Cancel keeps it, and Close tab takes the workspace with it");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
