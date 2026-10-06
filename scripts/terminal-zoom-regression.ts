import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { paneSendKeys, paneSendText } from "../server/herdr/client.ts";

/** Real xterm and resize frames, in an owned pane. Zoom must never become pty input. */
export async function checkTerminalZoom(browser: Browser, origin: string, paneId: string, deviceScaleFactor = 1): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor });
  try {
    await context.addInitScript((id) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-web-ui:view:${id}`, "terminal");
    }, paneId);
    const page = await context.newPage();
    const inputs: string[] = [];
    const resizes: { cols: number; rows: number }[] = [];
    const errors: string[] = [];
    let ready = false;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready") ready = message.ready !== false;
      });
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input") inputs.push(message.text);
        if (message.type === "resize") resizes.push(message);
      });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    const until = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 15_000;
      while (!check()) { assert(Date.now() < deadline, label); await Bun.sleep(25); }
    };
    await until(() => ready && resizes.length > 0, "terminal ready");
    await paneSendText(paneId, "printf '\\033[2J\\033[H\\033[1m한글 터미널 글씨 위가 잘림 ÅÉgjpqy\\033[0m\\n\\033[42m15 +Inside terminal Ctrl/Cmd 한글\\033[0m\\nGLYPH_READY\\n'");
    await paneSendKeys(paneId, ["Enter"]);
    await page.waitForFunction(() => document.querySelector(".xterm-rows > div")?.textContent?.startsWith("한글"), undefined, { timeout: 15_000 });
    const input = page.locator(".xterm-helper-textarea");
    const chrome = () => page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scale: visualViewport?.scale, font: getComputedStyle(document.body).fontSize }));
    const before = await chrome();
    const baseline = resizes.at(-1)!;
    const checkSize = async (size: number) => {
      await page.waitForFunction((want) => {
        const host = document.querySelector<HTMLElement>(".pane-terminal")!;
        const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
        return parseFloat(getComputedStyle(host.querySelector(".xterm-rows")!).fontSize) === want && screen.offsetWidth <= host.clientWidth;
      }, size, { timeout: 5_000 });
      assert.deepEqual(await chrome(), before, "zoom leaves page geometry and UI type unchanged");
    };
    for (const modifier of ["Meta", "Control"]) {
      await input.press(`${modifier}+Equal`);
      await checkSize(14);
      assert(resizes.at(-1)!.cols < baseline.cols, "larger text fits fewer columns and resizes herdr");
      await input.press(`${modifier}+Minus`);
      await checkSize(13);
      await input.press(`${modifier}+Shift+Equal`);
      await checkSize(14);
      await input.press(`${modifier}+Digit0`);
      await checkSize(13);
    }
    const wheel = (deltaY: number) => page.locator(".pane-terminal").evaluate((host, delta) => {
      const event = new WheelEvent("wheel", { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true });
      host.dispatchEvent(event);
      return event.defaultPrevented;
    }, deltaY);
    assert.equal(await wheel(-100), true, "terminal pinch/wheel cancels browser zoom");
    await checkSize(14);
    assert.equal(await wheel(100), true);
    await checkSize(13);
    // A marker bounds the assertion that no zoom chord or wheel report was sent to the pty.
    await input.press("Control+g");
    await until(() => inputs.includes("\x07"), "input marker");
    assert.deepEqual(inputs, ["\x07"]);

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await checkSize(14);
    await input.press("Control+Equal");
    await checkSize(15);
    await input.press("Control+Digit0");
    await checkSize(13);
    for (let i = 0; i < 15; i++) await input.press("Control+Equal");
    await checkSize(22);
    if (process.env.TERMINAL_ZOOM_SCREENSHOT) await page.screenshot({ path: process.env.TERMINAL_ZOOM_SCREENSHOT });
    for (let i = 0; i < 20; i++) await input.press("Control+Minus");
    await checkSize(10);
    await input.press("Control+Digit0");
    await checkSize(13);
    assert.equal(await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", { key: "+", ctrlKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }), false, "outside the terminal native browser zoom is untouched");
    const inputCount = inputs.length;
    await input.press("Control+Shift+Minus");
    await input.press("Control+g");
    await until(() => inputs.length >= inputCount + 2, "undo and input marker");
    assert.deepEqual(inputs.slice(inputCount), ["\x1f", "\x07"], "Ctrl+_ remains the pty's undo key");
    // A row's box fitting the host says nothing about ink clipped inside that row. Measure
    // the actual baseline and glyph ascent/descent, including the app's enlarged CJK spans.
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    const stepper = page.locator('.settings-stepper[aria-label="Terminal font size"]');
    let size = Number.parseInt(await stepper.locator("output").innerText());
    for (const wanted of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]) {
      const button = stepper.getByRole("button", { name: wanted > size ? "Increase terminal font size" : "Decrease terminal font size", exact: true });
      for (let i = 0; i < Math.abs(wanted - size); i++) await button.click();
      size = wanted;
      await checkSize(size);
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const ink = await page.evaluate(() => {
        const measure = document.createElement("canvas").getContext("2d")!;
        return [...document.querySelectorAll<HTMLElement>(".xterm-rows > div")].slice(0, 2).flatMap((row) => [...row.children].filter((span) => span.textContent?.trim()).map((span) => {
          const style = getComputedStyle(span);
          // A hidden clone supplies the browser's baseline without modifying xterm's rows.
          const clone = document.createElement("span");
          clone.style.cssText = `position:absolute;visibility:hidden;display:inline-block;top:0;height:${style.height};font-family:${style.fontFamily};font-size:${style.fontSize};font-weight:${style.fontWeight};line-height:${style.lineHeight}`;
          clone.textContent = span.textContent;
          const marker = document.createElement("i");
          marker.style.cssText = "display:inline-block;width:0;height:0;padding:0;vertical-align:baseline";
          clone.append(marker);
          document.body.append(clone);
          const baseline = marker.getBoundingClientRect().top - clone.getBoundingClientRect().top;
          measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const glyph = measure.measureText(span.textContent!);
          clone.remove();
          return { text: span.textContent, top: baseline - glyph.actualBoundingBoxAscent, bottom: baseline + glyph.actualBoundingBoxDescent, height: row.getBoundingClientRect().height };
        }));
      });
      assert(ink.some((glyph) => glyph.text?.includes("한글")), "measure real Korean output, not an empty screen");
      assert(ink.every((glyph) => glyph.top >= 0 && glyph.bottom <= glyph.height), `${size}px at DPR ${deviceScaleFactor}: glyph ink stays inside its row: ${JSON.stringify(ink)}`);
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    if (process.env.TERMINAL_ZOOM_SCREENSHOT) await page.screenshot({ path: process.env.TERMINAL_ZOOM_SCREENSHOT });
    assert.deepEqual(errors, []);
    console.log(`PASS terminal-only zoom, resize and unclipped Korean/Latin glyphs at 10–22px, DPR ${deviceScaleFactor}`);
  } finally { await context.close(); }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceClose, herdrRpc } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const root = mkdtempSync(join(tmpdir(), "herdr-terminal-zoom-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "" });
  let browser: Browser | undefined;
  let workspace: string | undefined;
  try {
    const made = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd: root, label: "herdr-web-ui-test-terminal-zoom", focus: false });
    workspace = made.workspace.workspace_id;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
    for (const scale of [1, 1.25, 1.5, 2]) await checkTerminalZoom(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id, scale);
  } finally {
    await browser?.close(); server.stop(true);
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
    console.log("CLEANUP terminal zoom context, server, owned workspace and temporary state closed");
  }
}
