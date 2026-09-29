import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

/** A plain left drag in the desktop terminal selects and copies instead of reaching herdr. */
export async function checkTerminalCopy(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-copy-ui-"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copy-ui" });
  const pane = created.root_pane.pane_id;
  const script = join(root, "show.cjs");
  writeFileSync(script, `
process.stdout.write("\\x1b[2J\\x1b[H");
process.stdout.write("DRAGCOPY-first-line\\r\\n");
process.stdout.write("LONG-" + "x".repeat(${300}) + "-END\\r\\n");
setInterval(() => {}, 1000);
`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript((id) => localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal"), pane);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const inputs: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input") inputs.push(message.text);
    }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".pane-terminal .xterm-rows").waitFor();
    await paneSendText(pane, `clear; node ${script}\r`);
    const first = page.locator(".pane-terminal .xterm-rows > div", { hasText: "DRAGCOPY-first-line" });
    await first.waitFor();

    /** Drags and returns what reached the pane between press and release (hover reports before it are herdr's). */
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<string[]> => {
      await page.mouse.move(from.x, from.y);
      await page.waitForTimeout(100);
      const before = inputs.length;
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(100);
      return inputs.slice(before);
    };
    const clipboard = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText());

    // plain drag: selects, copies on release, sends nothing to the pane
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const box = (await first.boundingBox())!;
    const dragged = await drag({ x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + 400, y: box.y + box.height / 2 });
    await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-drag-copy.png") });
    }
    assert.match(await clipboard(page), /^DRAGCOPY-first-line/, "a plain drag must copy the selected text");
    assert.deepEqual(dragged, [], "a selecting drag must not reach the pane as mouse reports");

    // Ctrl+C with a selection copies it and does not interrupt the pane
    await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(100);
    // releasing the double click already copied: empty the clipboard so only Ctrl+C can fill it
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const beforeCopy = inputs.length;
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);
    assert.equal(await clipboard(page), "DRAGCOPY-first-line", "Ctrl+C must copy the double-clicked word");
    assert.equal(inputs.length, beforeCopy, "Ctrl+C with a selection must not send ^C");
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);
    assert.equal(inputs.at(-1), "\x03", "Ctrl+C without a selection still interrupts");

    // a Korean layout: the C key reports "ㅊ", and Ctrl+C with a selection still copies
    await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const beforeHangul = inputs.length;
    const cdp = await context.newCDPSession(page);
    const hangulC = { key: "ㅊ", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...hangulC });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...hangulC });
    await page.waitForTimeout(300);
    assert.equal(await clipboard(page), "DRAGCOPY-first-line", "Ctrl+C on a Korean layout must copy the selection");
    assert.equal(inputs.length, beforeHangul, "Ctrl+C on a Korean layout with a selection must not send ^C");

    // a line longer than the terminal is wide: report how it copies
    const long = page.locator(".pane-terminal .xterm-rows > div", { hasText: "LONG-" });
    const longBox = (await long.boundingBox())!;
    const endRow = page.locator(".pane-terminal .xterm-rows > div", { hasText: "-END" });
    const endBox = (await endRow.boundingBox())!;
    await drag({ x: longBox.x + 1, y: longBox.y + longBox.height / 2 }, { x: endBox.x + 600, y: endBox.y + endBox.height / 2 });
    await page.waitForTimeout(300);
    const copied = await clipboard(page);
    assert.match(copied, /^LONG-x+/, "a wrapped line must copy");
    console.log(`INFO wrapped line copied ${copied.includes("\n") ? "with line breaks" : "as one line"} (${copied.length} chars)`);

    // plain HTTP (no navigator.clipboard): the copy command takes over
    const insecure = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await insecure.addInitScript((id) => {
        localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
        Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
        document.addEventListener("copy", (event) => {
          (window as any).copied = event.clipboardData?.getData("text/plain");
        });
      }, pane);
      const plain = await insecure.newPage();
      plain.setDefaultTimeout(10_000);
      const sent: string[] = [];
      plain.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input") sent.push(message.text);
      }));
      await plain.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      const row = plain.locator(".pane-terminal .xterm-rows > div", { hasText: "DRAGCOPY-first-line" });
      await row.waitFor();
      const rowBox = (await row.boundingBox())!;
      await plain.mouse.move(rowBox.x + 1, rowBox.y + rowBox.height / 2);
      await plain.mouse.down();
      await plain.mouse.move(rowBox.x + 400, rowBox.y + rowBox.height / 2, { steps: 6 });
      await plain.mouse.up();
      await plain.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
      assert.match(await plain.evaluate(() => (window as any).copied as string), /^DRAGCOPY-first-line/, "plain HTTP drag must copy");
      await plain.evaluate(() => { (window as any).copied = undefined; });
      await plain.mouse.dblclick(rowBox.x + 20, rowBox.y + rowBox.height / 2);
      await plain.waitForTimeout(100);
      await plain.evaluate(() => { (window as any).copied = undefined; });
      const beforeKey = sent.length;
      await plain.keyboard.press("Control+c");
      await plain.waitForTimeout(300);
      assert.equal(await plain.evaluate(() => (window as any).copied as string), "DRAGCOPY-first-line", "plain HTTP Ctrl+C must copy");
      assert.equal(sent.length, beforeKey, "plain HTTP Ctrl+C with a selection must not send ^C");
    } finally {
      await insecure.close();
    }
    console.log("PASS plain drag copies terminal text; Ctrl+C copies a selection (also without the async clipboard)");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
