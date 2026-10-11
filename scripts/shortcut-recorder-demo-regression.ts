/** Shortcut editing and dispatch on the production client over fictional demo fixtures only. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import panes from "../site/demo/fixtures/panes.json";

const app = mkdtempSync(join(tmpdir(), "herdr-shortcut-recorder-"));
const settingsKey = "herdr-web-ui:settings";
const overridesOf = (page: Page): Promise<Record<string, unknown>> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).shortcutOverrides, settingsKey);
const openShortcuts = async (page: Page) => {
  await page.keyboard.press("Meta+Shift+Comma");
  await openSettingsPage(page, "Shortcuts");
};
const rowOf = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const record = async (page: Page, action: string, chord: string) => {
  await page.getByRole("button", { name: `Record shortcut for ${action}`, exact: true }).click();
  await page.keyboard.press(chord);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const captureInput = `<script>(() => {
    const Demo = window.WebSocket;
    window.shortcutInputFrames = [];
    window.WebSocket = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(String(raw));
        if (["input", "keys", "submit"].includes(frame.type)) window.shortcutInputFrames.push(frame);
        send(raw);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(window.WebSocket, name, { value: Demo[name] });
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${captureInput}\n    <script type="module"`));
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
      const defaults = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale: "en-US" });
      try {
        await defaults.addInitScript(() => {
          Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux" });
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false, shortcutOverrides: { palette: "g" } }));
        });
        const page = await defaults.newPage();
        page.setDefaultTimeout(10_000);
        await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&settings=shortcuts`);
        await page.locator(".settings-shortcuts").waitFor();
        assert.equal(await page.getByText("This binding can override text editing or terminal keys.", { exact: true }).count(), 0, "default and legacy Ctrl+Shift bindings retain their safe default wording");
        assert.ok(await page.getByText(/Your browser or operating system may intercept/).count() > 0, "reserved-key warnings are unchanged");
      } finally { await defaults.close(); }
      for (const touch of [false, true]) {
        const context = await browser.newContext({ viewport: { width: touch ? 320 : 1280, height: 760 }, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: "iPad" });
            if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, voiceButton: "on", terminalInputMode: "direct", shortcutOverrides: {} }));
          });
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.api)}&view=chat`);
          await page.locator(".conn-live").waitFor();
          await openShortcuts(page);
          const paletteRow = rowOf(page, "Command palette");
          const recordButton = paletteRow.getByRole("button", { name: "Record shortcut for Command palette", exact: true });

          // Recorder owns default chords, modifiers and composition without changing persisted state.
          await recordButton.click();
          for (const key of ["Shift", "Control", "Meta", "Alt"]) await page.keyboard.press(key);
          assert.deepEqual(await overridesOf(page), {});
          await recordButton.dispatchEvent("keydown", { key: "K", code: "KeyK", metaKey: true, shiftKey: true, isComposing: true });
          await recordButton.dispatchEvent("keydown", { key: "K", code: "KeyK", metaKey: true, shiftKey: true, keyCode: 229 });
          assert.equal(await recordButton.getAttribute("aria-pressed"), "true");
          await page.keyboard.press("Meta+Shift+K");
          assert.equal(await page.getByRole("dialog", { name: "Command palette", exact: true }).count(), 0);
          assert.deepEqual(await overridesOf(page), {}, "preview is not persisted");
          await paletteRow.getByRole("button", { name: "Cancel", exact: true }).click();
          assert.equal(await recordButton.evaluate((node) => document.activeElement === node), true);
          await recordButton.click(); await page.keyboard.press("Escape");
          assert.equal(await paletteRow.getByRole("button", { name: "Save", exact: true }).count(), 0);
          await record(page, "Command palette", "Meta+PageUp");
          await page.keyboard.press("Escape");
          assert.equal(await paletteRow.getByRole("button", { name: "Save", exact: true }).count(), 0, "Escape cancels the candidate while the record button retains focus");
          assert.equal(await page.locator(".settings-dialog").isVisible(), true);
          assert.deepEqual(await overridesOf(page), {});
          await recordButton.click(); await page.keyboard.press("Tab");
          assert.equal(await recordButton.getAttribute("aria-pressed"), "false", "bare Tab exits capture for keyboard navigation");
          await paletteRow.getByRole("button", { name: "Cancel", exact: true }).click();

          await record(page, "Command palette", "Meta+PageUp");
          assert.match(await paletteRow.getByRole("status").first().innerText(), /⌘\+PageUp/);
          assert.deepEqual(await overridesOf(page), {});
          await paletteRow.getByRole("button", { name: "Save", exact: true }).click();
          const commandPage = { key: "PageUp", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false };
          assert.deepEqual((await overridesOf(page)).palette, commandPage);
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          const composer = page.locator(".pane-frame.is-current .composer-text");
          await page.keyboard.press("Meta+Shift+PageUp");
          assert.equal(await page.getByRole("dialog", { name: "Command palette", exact: true }).count(), 0, "an extra Shift never matches");
          await composer.fill("Keep this draft and selection");
          await composer.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(5, 15));
          await page.keyboard.press("Meta+PageUp");
          await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
          await page.getByRole("button", { name: "Close command palette", exact: true }).click();
          assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.value, node.selectionStart, node.selectionEnd]), ["Keep this draft and selection", 5, 15]);
          await page.reload(); await page.locator(".conn-live").waitFor();
          assert.deepEqual((await overridesOf(page)).palette, commandPage, "exact modifiers survive reload");
          await openShortcuts(page);

          // Exact app collisions, default aliases and fixed dictation conflicts all block Save.
          for (const chord of ["Meta+Shift+O", "Meta+Shift+N", "Meta+Shift+Space"]) {
            await record(page, "Command palette", chord);
            await paletteRow.getByText("Already assigned", { exact: true }).waitFor();
            assert.equal(await paletteRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
            assert.deepEqual((await overridesOf(page)).palette, commandPage);
            await paletteRow.getByRole("button", { name: "Cancel", exact: true }).click();
          }
          // A different modifier set on Space remains configurable.
          await paletteRow.getByRole("button", { name: "Edit shortcut for Command palette", exact: true }).click();
          await paletteRow.getByLabel("⌘", { exact: true }).uncheck();
          await paletteRow.getByRole("combobox", { name: "Shortcut key", exact: true }).selectOption("Space");
          assert.equal(await paletteRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), false);
          await paletteRow.getByRole("button", { name: "Cancel", exact: true }).click();

          // Manual touch fallback does not need a hardware keydown, and survives invalid intermediate input.
          await paletteRow.getByRole("button", { name: "Edit shortcut for Command palette", exact: true }).click();
          await paletteRow.getByRole("combobox", { name: "Shortcut key", exact: true }).selectOption("custom");
          const manual = paletteRow.getByLabel("Type a character or key name", { exact: true });
          await manual.fill("ab");
          assert.equal(await paletteRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
          await manual.fill("U");
          assert.equal(await manual.evaluate((node) => document.activeElement === node), true, "custom input remains mounted after a known letter");
          await page.keyboard.insertText("\u030b");
          await paletteRow.getByLabel("Alt", { exact: true }).check();
          if (touch && process.env.UI_EVIDENCE_DIR) {
            mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
            await paletteRow.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "shortcut-recorder-manual-phone.png") });
            assert.equal(await page.locator(".settings-body:not([hidden])").evaluate((node) => node.scrollWidth <= node.clientWidth), true, "expanded editor fits a 320px phone");
          }
          await paletteRow.getByRole("button", { name: "Save", exact: true }).click();
          assert.deepEqual((await overridesOf(page)).palette, { key: "ű", metaKey: true, ctrlKey: false, shiftKey: false, altKey: true });

          // Current bare-key overrides must not fire while typing or using Save/Cancel in an editor.
          await record(page, "Command palette", "u");
          await paletteRow.getByText("This binding can override text editing or terminal keys.", { exact: true }).waitFor();
          await paletteRow.getByRole("button", { name: "Save", exact: true }).click();
          await paletteRow.getByRole("button", { name: "Edit shortcut for Command palette", exact: true }).click();
          await paletteRow.getByRole("combobox", { name: "Shortcut key", exact: true }).selectOption("custom");
          await manual.focus(); await page.keyboard.type("u");
          assert.equal(await page.getByRole("dialog", { name: "Command palette", exact: true }).count(), 0);
          await paletteRow.getByRole("button", { name: "Cancel", exact: true }).focus(); await page.keyboard.press("Enter");
          assert.equal(await recordButton.evaluate((node) => document.activeElement === node), true);

          // Custom Enter/Tab/Escape are handled before composer completion, Send and abort handlers.
          for (const key of ["Enter", "Tab", "Escape"]) {
            await paletteRow.getByRole("button", { name: "Edit shortcut for Command palette", exact: true }).click();
            await paletteRow.getByRole("combobox", { name: "Shortcut key", exact: true }).selectOption(key);
            await paletteRow.getByLabel("⌘", { exact: true }).check();
            await paletteRow.getByRole("button", { name: "Save", exact: true }).focus(); await page.keyboard.press("Enter");
            await page.getByRole("button", { name: "Close settings", exact: true }).click();
            await composer.fill("/comments");
            await page.getByRole("listbox", { name: "Slash commands", exact: true }).getByRole("option").last().waitFor();
            await composer.evaluate((node) => {
              node.setAttribute("data-shortcut-leaks", "0");
              node.addEventListener("keydown", (event) => {
                if (["Enter", "Tab", "Escape"].includes(event.key)) node.setAttribute("data-shortcut-leaks", String(Number(node.getAttribute("data-shortcut-leaks")) + 1));
              });
            });
            await page.keyboard.press(`Meta+${key}`);
            await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
            assert.equal(await composer.inputValue(), "/comments", `${key} neither submits nor edits the draft`);
            assert.equal(await composer.getAttribute("data-shortcut-leaks"), "0", `${key} never reaches the composer`);
            await page.getByRole("button", { name: "Close command palette", exact: true }).click();
            await openShortcuts(page);
          }
          // A custom Ctrl binding must not also reach the PTY encoder.
          await record(page, "Command palette", "Control+F8");
          await paletteRow.getByRole("button", { name: "Save", exact: true }).click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          await page.goto(`http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.shell)}&view=terminal`);
          await page.locator(".conn-live").waitFor();
          await page.locator(".pane-frame.is-current .xterm-helper-textarea").focus();
          const framesBefore = await page.evaluate(() => (window as unknown as { shortcutInputFrames: unknown[] }).shortcutInputFrames.length);
          await page.keyboard.press("Control+F8");
          await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { shortcutInputFrames: unknown[] }).shortcutInputFrames.length), framesBefore, "matched Ctrl chord sends no terminal input");
          await page.getByRole("button", { name: "Close command palette", exact: true }).click();
          await openShortcuts(page);
          await page.getByRole("button", { name: "Disable shortcut for Command palette", exact: true }).click();
          assert.equal((await overridesOf(page)).palette, null);
          await page.getByRole("button", { name: "Restore default shortcut for Command palette", exact: true }).click();
          assert.equal(Object.hasOwn(await overridesOf(page), "palette"), false);
          await page.getByRole("button", { name: "Reset shortcuts", exact: true }).click();
          assert.deepEqual(await overridesOf(page), {});
          assert.deepEqual(errors, []);
          console.log(`PASS shortcut recorder: ${touch ? "320px touch" : "desktop"}, preview, cancellation, manual editing, exact dispatch, conflicts and composer isolation`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
