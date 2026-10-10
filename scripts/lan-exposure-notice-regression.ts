import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import { createServer } from "../server/index.ts";

/**
 * The line that says this server can be reached from the network with no token and nothing
 * paired (#698). It is drawn from `lan_exposure` on `/api/health`, which the server sends only
 * to a request that got in — so the check drives the real server, with a real herdr behind it,
 * rather than a canned answer, and asks two questions:
 *
 *   1. does it appear, name the address, and carry the danger tint, on a server bound past
 *      this PC with no token and nothing paired?
 *   2. does it stay away on the same empty configuration bound to loopback, which is
 *      unreachable from the network however it is addressed?
 *
 * The second half is the one that matters. A notice that renders unconditionally is worse than
 * no notice: it would train the owner to ignore a line that is only true sometimes.
 *
 * Needs `dist/` (`bun run build`), the way the other browser scripts here do.
 */
const NOTICE = '[data-testid="lan-exposure-notice"]';

async function notice(page: Page): Promise<{ visible: boolean; text: string | null; tint: string | null }> {
  const locator = page.locator(NOTICE);
  await locator.waitFor({ state: "attached", timeout: 5000 }).catch(() => undefined);
  const visible = await locator.isVisible().catch(() => false);
  return {
    visible,
    text: visible ? (await locator.innerText()).replace(/\s+/g, " ").trim() : null,
    tint: visible ? await locator.evaluate((node) => getComputedStyle(node).backgroundColor) : null,
  };
}

async function read(browser: Browser, hostname: string): Promise<{ visible: boolean; text: string | null; tint: string | null }> {
  const stateDir = mkdtempSync(join(tmpdir(), `herdr-lan-${hostname === "0.0.0.0" ? "exposed" : "loopback"}-`));
  // no token and nothing paired in both cases: the only difference is where it is reachable
  const server = createServer({ port: 0, hostname, stateDir });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.port}`, { waitUntil: "load" });
    const found = await notice(page);
    assert.deepEqual(errors, [], "the page raised no error");
    return found;
  } finally {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const dist = join(import.meta.dir, "..", "dist", "index.html");
if (!existsSync(dist)) {
  console.error("dist/index.html is missing: run `bun run build` first");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  const exposed = await read(browser, "0.0.0.0");
  console.log(`exposed   : ${JSON.stringify(exposed)}`);
  assert.ok(exposed.visible, "the notice appears on a server reachable from the network");
  assert.ok(exposed.text?.includes("0.0.0.0"), "the notice names the address it is reachable at");
  assert.ok(exposed.tint !== null, "the notice carries a background of its own");
  console.log("PASS the open-to-the-network notice appears and names the address");

  const loopback = await read(browser, "127.0.0.1");
  console.log(`loopback  : ${JSON.stringify(loopback)}`);
  assert.ok(!loopback.visible, "the same empty configuration on a loopback bind shows no notice");
  console.log("PASS a loopback bind with no token and nothing paired shows no notice");
} finally {
  await browser.close();
}