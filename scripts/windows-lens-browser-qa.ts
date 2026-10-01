/** What a Windows PC looks like in the browser: the health answer says `terminal_attach: false`
 * and an attach is refused with `terminal_unsupported`, both faked here over a real pane, since
 * the test herdr is a Unix one. Run after `bun run build`; UI_EVIDENCE_DIR saves screenshots. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { TERMINAL_UNSUPPORTED_MESSAGE } from "../server/index.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-winlens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const cwd = join(root, "pane"); mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.herdr.terminal_attach = false;
    await route.fulfill({ response, json: body });
  });
  let attaches = 0;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "attach") {
        attaches++;
        socket.send(JSON.stringify({ type: "error", code: "terminal_unsupported", message: TERMINAL_UNSUPPORTED_MESSAGE, pane_id: message.pane_id }));
        return;
      }
      upstream.send(raw);
    });
  });
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  const chat = page.getByRole("button", { name: /^Chat/ });
  const terminal = page.getByRole("button", { name: /^Terminal/ });
  await chat.waitFor();
  assert.equal(await chat.getAttribute("aria-pressed"), "true", "a Windows PC's pane opens in its chat");
  await terminal.locator(".pill-soon").waitFor();
  assert.equal(await terminal.getAttribute("title"), "Live terminal: coming to Windows PCs once herdr can attach there");
  if (evidence) await page.screenshot({ path: join(evidence, "windows-lens-chat.png") });
  console.log("PASS a Windows PC opens in the chat lens with a soon pill on Terminal");
  await terminal.click();
  const banner = page.locator(".terminal-banner-soon");
  await banner.waitFor();
  assert.ok(attaches >= 1, "the terminal lens asked for an attach");
  assert.equal((await banner.innerText()).trim(), "Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet. The chat lens works now.");
  assert.equal(await page.locator(".terminal-banner-output-error").count(), 0, "not shown as a fault");
  if (evidence) await page.screenshot({ path: join(evidence, "windows-lens-terminal.png") });
  await chat.click();
  await banner.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log("PASS the terminal lens shows the coming-soon notice, not an error, and the chat lens hides it");
} finally {
  await browser?.close();
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
