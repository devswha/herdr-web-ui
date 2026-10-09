import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-keymap-ui-"));
const config = join(root, "config.toml");
writeFileSync(config, '[keys]\nprefix = "ctrl+b"\nsettings = "cmd+shift+k"\ntoggle_sidebar = "cmd+t"\n[[keys.command]]\nkey = "prefix+x"\ntype = "shell"\ndescription = "Fixture command"\ncommand = "private-command-body"\n');
const workspace = await workspaceCreate({ cwd: root, label: "Keymap QA", focus: false });
const paneId = workspace.root_pane.pane_id;
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
  herdrConfigPath: config, usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true });
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ ...(width === 390 ? devices["iPhone 14"] : {}),
      viewport: { width, height: 900 }, reducedMotion: "reduce" });
    try {
      await context.addInitScript(({ theme, paneId }) => {
        Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
        if (!localStorage.getItem("herdr-web-ui:settings")) {
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ theme, language: "en", importHerdrKeys: false }));
          localStorage.setItem(`herdr-web-ui:view:${paneId}`, "terminal");
        }
      }, { theme, paneId });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let reads = 0;
      let unavailable = false;
      await page.route("**/api/keybindings", async (route) => {
        reads++;
        if (unavailable) await route.fulfill({ status: 404, json: { error: { code: "not_found", message: "Fixture old bridge" } } });
        else await route.continue();
      });
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const openSettings = async () => {
        await page.keyboard.press("Meta+Shift+,");
        await openSettingsPage(page, "Shortcuts");
      };
      await openSettings();
      const settings = page.locator(".settings-dialog");
      const toggle = settings.getByRole("switch", { name: "Import Herdr key bindings", exact: true });
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.equal(reads, 0, "disabled import does not read the PC configuration");
      const loaded = page.waitForResponse((response) => response.url().endsWith("/api/keybindings") && response.status() === 200);
      await toggle.click();
      await loaded;
      await settings.getByText("Fixture command", { exact: true }).waitFor();
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.ok((await settings.innerText()).includes("Reserved for the browser, system, or web shortcuts"));
      assert.equal((await settings.innerText()).includes("private-command-body"), false);
      await settings.getByText("Herdr key bindings", { exact: true }).evaluate((heading) => {
        const body = heading.closest(".settings-body");
        if (!body) throw new Error("Missing settings scroll surface");
        body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top;
      });
      if (evidence) await settings.screenshot({ path: join(evidence, `keymap-${width}-${theme}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await settings.getByRole("button", { name: "Close settings", exact: true }).click();

      const prefix = page.getByText("Herdr prefix", { exact: true });
      await page.locator(".terminal-host").click();
      const prefixed = prefix.waitFor();
      await page.keyboard.press("Control+b");
      await prefixed;
      const newWorkspace = page.locator(".new-session-modal");
      const opened = newWorkspace.waitFor();
      await page.keyboard.press("Shift+n");
      await opened;
      await newWorkspace.getByRole("heading", { name: /New workspace/ }).waitFor();
      assert.equal(await newWorkspace.getByLabel("Directory", { exact: true }).inputValue(), root);
      assert.equal(await newWorkspace.getByLabel("Directory", { exact: true }).evaluate((input) => {
        const event = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(event);
        return event.defaultPrevented;
      }), false, "text input keeps its own editing key");
      assert.equal(await prefix.count(), 0);
      await newWorkspace.getByRole("button", { name: "Close dialog", exact: true }).click();

      await page.locator(".terminal-host").click();
      const nextPrefix = prefix.waitFor();
      await page.keyboard.press("Control+b");
      await nextPrefix;
      const cancelled = prefix.waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await cancelled;
      assert.equal(await page.locator(".terminal-host").evaluate((host) => {
        const event = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, isComposing: true, bubbles: true, cancelable: true });
        host.dispatchEvent(event);
        return event.defaultPrevented;
      }), false, "IME composition never starts the imported prefix");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      const paletteOpened = palette.waitFor();
      await page.keyboard.press("Meta+Shift+k");
      await paletteOpened;
      assert.equal(await settings.count(), 0, "existing web shortcut wins over an imported settings binding");
      await palette.getByRole("button", { name: "Close command palette", exact: true }).click();

      await page.reload();
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings();
      assert.equal(await toggle.getAttribute("aria-checked"), "true", "opt-in persists across reload");
      await settings.getByText("Fixture command", { exact: true }).waitFor();
      unavailable = true;
      const failed = settings.getByRole("alert").filter({ hasText: "Fixture old bridge" }).waitFor();
      await settings.getByRole("button", { name: "Reload bindings", exact: true }).click();
      await failed;
      await settings.getByRole("button", { name: "Close settings", exact: true }).click();
      assert.equal(await page.locator(".terminal-host").evaluate((host) => {
        const event = new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true });
        host.dispatchEvent(event);
        return event.defaultPrevented;
      }), false, "an unavailable bridge never leaves its old keymap installed");
      assert.deepEqual(errors, []);
      console.log(`PASS keymap opt-in, prefix, text/IME protection, web priority, reload and old bridge: ${width} ${theme}`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close(); server.stop(true);
  await workspaceClose(workspace.workspace.workspace_id);
  rmSync(root, { recursive: true, force: true });
}
