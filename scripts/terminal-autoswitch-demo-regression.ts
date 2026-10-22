import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

// Real client and demo transport. Only receipts and demo-turn completion are held, then released
// explicitly: no provider, live herdr, sleeps or deadline-dependent assertions.
const app = mkdtempSync(join(tmpdir(), "terminal-autoswitch-"));
const evidence = join(process.env.UI_EVIDENCE_DIR ?? "/tmp/terminal-autoswitch-shots", "edges");
mkdirSync(evidence, { recursive: true });
await buildDemoApp(app);
const html = await Bun.file(join(app, "index.html")).text();
const setup = `<script>(() => {
const turnsToFinish = [];
const later = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => {
  if (ms === 2400 || ms === 4500) { turnsToFinish.push(() => fn(...args)); return 0; }
  return later(fn, ms, ...args);
};
window.finishDemoTurns = () => { const ready = turnsToFinish.splice(0); ready.forEach(fn => fn()); };
window.sentFrames = [];
window.receiptMode = "normal";
window.releaseReceipt = null;
window.discardOnSteer = false;
})();</script><script src="/demo-transport.js"></script><script>(() => {
const Socket = window.WebSocket;
window.WebSocket = function(...args) {
  const socket = new Socket(...args);
  window.demoSocket = socket;
  const send = socket.send.bind(socket);
  socket.send = (raw) => {
    const frame = JSON.parse(raw);
    window.sentFrames.push(frame);
    if (frame.type === "pending-action" && frame.action === "steer" && window.discardOnSteer) {
      send(JSON.stringify({...frame, id: frame.id + 10000, action: "discard"}));
    }
    if (frame.type === "submit" && window.receiptMode !== "normal") {
      window.releaseReceipt = () => {
        if (window.receiptMode === "hold") send(raw);
        else socket.push({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: false,
          code: window.receiptMode === "unconfirmed" ? "submit_unconfirmed" : "agent_not_ready",
          message: "The fixture refused the command." });
        window.releaseReceipt = null;
      };
      return;
    }
    send(raw);
  };
  return socket;
};
Object.assign(window.WebSocket, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED });
const fetch = window.fetch;
window.focusCalls = [];
window.fetch = (input, init) => {
  if (String(input).includes("/pane/focus")) window.focusCalls.push(String(input));
  return fetch(input, init);
};
const json = Response.prototype.json;
Response.prototype.json = async function() {
  const value = await json.call(this);
  if (Array.isArray(value.turns)) {
    const history = Array.from({length: 24}, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      ts: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      parts: [{kind:"text", text: "Earlier fixture turn " + index + ". " + "A stable paragraph for the reading-position regression. ".repeat(8)}]
    }));
    value.turns = [...history, ...value.turns];
  }
  return value;
};
})();</script>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(html.replace('<script type="module"', `${setup}<script type="module"`), { headers: { "Content-Type": "text/html" } });
  if (path.includes("..")) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(app, path.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const chat = (page: Page) => page.locator(`.terminal-stack.is-chat[data-pane-owner="${panes.flaky}"]`);
const box = (page: Page) => chat(page).locator(".composer-text");
const hint = (page: Page) => page.locator(".terminal-banner-command");
const send = async (page: Page, text: string) => {
  await box(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
};
const finish = async (page: Page) => page.evaluate("window.finishDemoTurns()");
const capture = async (page: Page, name: string) => page.screenshot({ path: join(evidence, `${name}.png`), animations: "disabled" });
const ready = async (page: Page) => {
  await chat(page).locator(".composer-status[data-status='done'], .composer-status[data-status='idle']").waitFor();
};
try {
  for (const width of [1280, 390]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, locale: "en-US" });
    try {
      await context.addInitScript(({ theme, pane }) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme, darkTheme: "amber", lightTheme: "amber", autoSendQueued: true }));
        localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
      }, { theme, pane: panes.flaky });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
      page.setDefaultTimeout(10_000);
      await page.goto(`${server.url}?pane=${encodeURIComponent(panes.flaky)}`);
      await chat(page).locator(".composer").waitFor();
      await appFaces(page);
      page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
      // The exact menu row proves that the shared command catalog has loaded.
      await box(page).fill("/conf");
      await page.locator('.menu-item[data-terminal]').first().waitFor();
      await box(page).fill("");
      const tag = `${width}-${theme}`;

      for (const mode of ["refused", "unconfirmed"]) {
        await page.evaluate((mode) => { Object.assign(window, { receiptMode: mode }); }, mode);
        await send(page, "/config");
        await page.waitForFunction("window.releaseReceipt !== null").catch(async (error) => {
          console.error(await page.evaluate("JSON.stringify({mode:window.receiptMode,frames:window.sentFrames})"));
          await capture(page, `${tag}-receipt-failure`);
          throw error;
        });
        assert.equal(await chat(page).count(), 1, "no switch before acceptance");
        await page.evaluate("window.releaseReceipt()");
        await chat(page).locator(".composer-note").waitFor();
        assert.equal(await box(page).inputValue(), "/config");
        assert.equal(await hint(page).count(), 0);
        await capture(page, `${tag}-${mode}`);
      }
      console.log(`PASS ${tag}: refused and unconfirmed sends retain the draft and lens`);

      await page.evaluate("window.receiptMode = 'hold'");
      await send(page, "/config");
      await page.waitForFunction("window.releaseReceipt !== null");
      // Scroll while the receipt is held, so the saved place cannot be a guessed end offset.
      await box(page).press("PageUp");
      await box(page).press("PageUp");
      await page.waitForFunction(() => {
        const log = document.querySelector('[role="log"]');
        return log && [...log.querySelectorAll("[data-chat-row]")].some((row) => {
          const top = log.getBoundingClientRect().top;
          const rect = row.getBoundingClientRect();
          return rect.top <= top && rect.bottom > top;
        });
      });
      const place = await chat(page).getByRole("log").evaluate((node) => {
        const top = node.getBoundingClientRect().top;
        const row = [...node.querySelectorAll("[data-chat-row]")].find((row) => row.getBoundingClientRect().bottom > top);
        return { text: row?.textContent, offset: (row?.getBoundingClientRect().top ?? 0) - top };
      });
      assert.ok(place.text);
      await page.evaluate("window.releaseReceipt()");
      await hint(page).waitFor();
      await capture(page, `${tag}-accepted`);
      await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
      await chat(page).getByRole("log").waitFor();
      await page.waitForFunction(({ pane, place }) => {
        const log = document.querySelector(`.terminal-stack.is-chat[data-pane-owner="${pane}"] [role="log"]`);
        const row = log && [...log.querySelectorAll("[data-chat-row]")].find((row) => row.textContent === place.text);
        return row && log && Math.abs(row.getBoundingClientRect().top - log.getBoundingClientRect().top - place.offset) < 3;
      }, { pane: panes.flaky, place }).catch(async (error) => {
        await capture(page, `${tag}-position-failure`);
        console.error(JSON.stringify({ place, rows: await chat(page).getByRole("log").evaluate((node) => [...node.querySelectorAll("[data-chat-row]")].map(row => ({ text: row.textContent?.slice(0, 60), offset: row.getBoundingClientRect().top - node.getBoundingClientRect().top }))) }));
        throw error;
      });
      assert.equal(await box(page).inputValue(), "");
      await capture(page, `${tag}-reading-position`);
      console.log(`PASS ${tag}: delayed acceptance switches and Back restores the reading position`);

      await page.evaluate("window.receiptMode = 'normal'");
      await send(page, "Start a deterministic demo turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      assert.equal(await hint(page).count(), 0);
      assert.equal(await chat(page).count(), 1);
      await capture(page, `${tag}-queued`);
      await page.getByRole("button", { name: "Send now: /config", exact: true }).click();
      await hint(page).waitFor();
      await capture(page, `${tag}-send-now`);
      await hint(page).getByRole("button", { name: "Back to Chat", exact: true }).click();
      await finish(page);
      await ready(page);
      console.log(`PASS ${tag}: queue acceptance stays in Chat, explicit Send now opens Terminal`);

      await send(page, "Start the automatic-delivery turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      await finish(page);
      await page.locator(".pending-message").waitFor({ state: "detached" });
      await ready(page);
      assert.equal(await chat(page).count(), 1);
      assert.equal(await hint(page).count(), 0);
      console.log(`PASS ${tag}: automatic queue delivery never switches lenses`);

      await send(page, "Start the discard-race turn");
      await chat(page).locator('.composer-status[data-status="working"]').waitFor();
      await send(page, "/config");
      await page.locator(".pending-message").waitFor();
      await page.evaluate("window.discardOnSteer = true");
      await page.getByRole("button", { name: "Send now: /config", exact: true }).click();
      await page.locator(".pending-message").waitFor({ state: "detached" });
      assert.equal(await chat(page).count(), 1, "a successful replay of discard is not delivery");
      assert.equal(await hint(page).count(), 0);
      await page.evaluate("window.discardOnSteer = false");
      await finish(page);
      await ready(page);
      console.log(`PASS ${tag}: concurrent discard plus successful action ACK never switches`);

      // The server's confirmed role controls input. A command outcome published to this reader
      // still cannot switch its lens; no composer remains from which it could submit one.
      await page.evaluate("window.demoSocket.send(JSON.stringify({type:'role', mode:'observe'}))");
      await chat(page).locator(".composer").waitFor({ state: "detached" });
      assert.equal(await chat(page).count(), 1);
      assert.equal(await hint(page).count(), 0);
      const forbidden = await page.evaluate("window.sentFrames.filter(frame => frame.type === 'focus' || frame.type === 'take-over')");
      assert.deepEqual(forbidden, []);
      assert.deepEqual(await page.evaluate("window.focusCalls"), []);
      assert.deepEqual(errors, []);
      await capture(page, `${tag}-watch-only`);
      console.log(`PASS ${tag}: watch-only stays in Chat without a composer; no focus or takeover frames`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  server.stop(true);
  rmSync(app, { recursive: true, force: true });
}
console.log(`PASS terminal autoswitch edge cases; screenshots in ${evidence}`);
