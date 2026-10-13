import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// A render error never blanks the app. The lane's demo build has its test hooks on, so
// `?crash=<region>` makes that region throw while it renders (src/lib/crashProbe.ts):
// - root: the whole page is AppCrash, with Reload app (which reloads) and Copy details;
// - sidebar, pane: that region shows its notice and the rest of the app keeps working;
// - settings: the dialog shows its notice and Close returns to the app.
// On the unmodified app over the demo's fixture transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-render-crash-demo-"));

async function open(browser: Browser, search: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/${search}`);
  return { page, close: () => context.close() };
}

/** Drops `crash` from the address, as the page would be without the hook, so Try again can succeed. */
const stopCrashing = (page: Page): Promise<void> => page.evaluate(() => {
  const url = new URL(window.location.href);
  url.searchParams.delete("crash");
  window.history.replaceState(window.history.state, "", url);
});

let port = 0;
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
  port = server.port ?? 0;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const pane = `?pane=${encodeURIComponent(panes.infra)}&view=terminal`;

      // without the hook asked for, nothing throws: the probe is inert
      {
        const { page, close } = await open(browser, pane);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".pane-frame.is-current").waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.getByRole("alert").filter({ hasText: /can't be shown|Something went wrong/ }).count(), 0, "no notice on a page that did not throw");
        assert.deepEqual(errors, []);
        await close();
      }

      // the root: AppCrash, its Reload app reloads the page, Copy details puts the error on the clipboard
      {
        const { page, close } = await open(browser, `${pane}&crash=root`);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const crash = page.locator(".app-crash");
        await crash.getByRole("heading", { name: "Something went wrong" }).waitFor();
        const reload = crash.getByRole("button", { name: "Reload app", exact: true });
        assert.equal(await reload.isVisible(), true, "Reload app is offered");
        await crash.getByRole("button", { name: "Copy details", exact: true }).click();
        await crash.getByRole("button", { name: "Copied", exact: true }).waitFor();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(copied, /crash probe: root/, "the details carry the error");
        await crash.locator("summary").click();
        assert.match(await crash.locator("pre").innerText(), /crash probe: root/, "the details are on the page too");
        const reloaded = page.waitForEvent("load");
        await reload.click();
        await reloaded;
        await crash.getByRole("button", { name: "Reload app", exact: true }).waitFor();
        await close();
      }

      // the sidebar: its notice, the pane still drawn; Try again draws the sidebar once it can
      {
        const { page, close } = await open(browser, `${pane}&crash=sidebar`);
        const notice = page.locator("#workspace-drawer").getByRole("alert").filter({ hasText: "The sidebar can't be shown." });
        await notice.waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await notice.count(), 0, "the notice gives way to the sidebar");
        await close();
      }

      // a pane slot: its notice, the sidebar still drawn
      {
        const { page, close } = await open(browser, `${pane}&crash=pane`);
        const notice = page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." });
        await notice.waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".pane-frame.is-current").waitFor();
        await close();
      }

      // Settings: its notice in the dialog; Close returns to a working app
      {
        const { page, close } = await open(browser, `${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.locator(".sidebar-shell").waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }
      console.log("PASS a render error shows a notice with Reload app at the root, and stays inside the sidebar, a pane slot or Settings");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
