/**
 * Two browsers of one server keep the shared settings and pins the same (lib/preferencesSync.ts):
 * a theme changed in one shows in the other at once, the other's terminal font (this device's)
 * does not move and is never sent, pins written elsewhere reach an open page, and opening a page
 * on an empty server sends nothing. No herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";

await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { UsageService } = await import("../server/usage.ts");

const root = mkdtempSync(join(tmpdir(), "herdr-preferences-sync-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const origin = `http://127.0.0.1:${server.port}`;

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}

/** a browser of its own; `puts` collects what it sends to /api/preferences */
async function browserAt(browser: Awaited<ReturnType<typeof chromium.launch>>, own: Record<string, unknown> = {}): Promise<{ context: BrowserContext; page: Page; puts: unknown[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
  await context.addInitScript((own) => {
    // what the page hears on its event stream, for the pins below (a pin of a pane that is not an
    // agent here is dropped by the sidebar as soon as it lands, so the stored list cannot tell)
    const heard: unknown[] = [];
    (window as unknown as { heardPreferences: unknown[] }).heardPreferences = heard;
    const Source = window.EventSource;
    window.EventSource = class extends Source {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("message", (event) => {
          const data = JSON.parse((event as MessageEvent<string>).data) as { type: string; preferences?: unknown };
          if (data.type === "preferences") heard.push(data.preferences);
        });
      }
    };
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark", terminalFontSize: 13, ...own }));
  }, own);
  const puts: unknown[] = [];
  const page = await context.newPage();
  page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith("/api/preferences")) puts.push(request.postDataJSON()); });
  await page.goto(origin);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page, puts };
}

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset["theme"]);
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as Record<string, unknown>);

try {
  const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const a = await browserAt(browser);
    const b = await browserAt(browser);
    await Bun.sleep(1_500);
    assert.deepEqual([...a.puts, ...b.puts], [], "opening a page on an empty server sends nothing");

    // A turns light: B follows while open, and only the shared settings went out
    await a.page.goto(`${origin}/?settings=appearance`);
    await a.page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
    await until(async () => await theme(b.page) === "light", "B takes A's theme without a reload");
    assert.equal(a.puts.length >= 1, true);
    assert.deepEqual((a.puts as { settings: Record<string, unknown> }[]).map((body) => Object.keys(body.settings)), [["theme"]], "only the setting that changed is sent");

    // A's terminal font is A's own: B keeps 13
    await a.page.goto(`${origin}/?settings=terminal`);
    await a.page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await until(async () => (await stored(a.page))["terminalFontSize"] === 14, "A keeps its new font");
    await Bun.sleep(1_500);
    assert.equal(a.puts.length, 1, "a device setting is never sent");
    assert.equal((await stored(b.page))["terminalFontSize"], 13, "B's terminal font does not move");

    // pins written by another browser reach an open page
    const pins = ["local:w9:p1"];
    const heardBefore = await a.page.evaluate(() => (window as unknown as { heardPreferences: unknown[] }).heardPreferences.length);
    const status = await b.page.evaluate(async (body) => (await fetch("/api/preferences", { method: "PUT", headers: { "content-type": "application/json" }, body })).status,
      JSON.stringify({ settings: { theme: "light" }, pins }));
    assert.equal(status, 200);
    await until(async () => await a.page.evaluate(([from, want]) => (window as unknown as { heardPreferences: { pins: string[] }[] }).heardPreferences.slice(from)
      .some((preferences) => JSON.stringify(preferences.pins) === want), [heardBefore, JSON.stringify(pins)] as const), "A hears the pins");

    // a page opened later starts from what the server holds, and keeps a shared setting nobody changed
    const c = await browserAt(browser, { showThinking: false });
    await until(async () => await theme(c.page) === "light", "a new page takes the shared theme");
    assert.equal((await stored(c.page))["terminalFontSize"], 13, "and keeps its own terminal font");
    assert.equal((await stored(c.page))["showThinking"], false, "and a shared setting nobody changed stays its own");
    for (const opened of [a, b, c]) await opened.context.close();
    console.log("PASS shared settings and pins follow across browsers, device settings stay, an empty server is never written on load");
  } finally {
    await browser.close();
  }
} finally {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
