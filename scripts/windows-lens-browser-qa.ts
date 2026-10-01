/** What a PC without terminal attach (Windows, herdrdev/herdr#4821) looks like in the browser:
 * the server answers as a Windows herdr would (`terminalAttach: false`) over a real pane of
 * the test herdr, and the terminal lens shows that pane's screen, mirrored. Run after
 * `bun run build`; UI_EVIDENCE_DIR saves screenshots. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-winlens-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function until(done: () => Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await done()) return; await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const screen = (page: Page) => page.locator(".xterm-rows").innerText();

try {
  const cwd = join(root, "pane"); mkdirSync(cwd);
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-winlens" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), terminalAttach: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const health = await (await fetch(`${origin}/api/health`)).json() as { herdr: { terminal_attach?: boolean; terminal_mirror?: boolean } };
  assert.deepEqual([health.herdr.terminal_attach, health.herdr.terminal_mirror], [false, true]);
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  const terminal = page.getByRole("button", { name: /^Terminal/ });
  await terminal.waitFor();
  assert.equal(await terminal.getAttribute("aria-pressed"), "true", "a shell pane opens in the terminal lens");
  assert.equal(await terminal.locator(".pill-soon").count(), 0, "no soon pill: the lens works");
  assert.equal(await page.locator(".terminal-banner-soon").count(), 0);
  // typed in the page, run by the pane's shell, read back from herdr's screen
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo mirror-ok-$((40+2))");
  await page.keyboard.press("Enter");
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the command's output reaches the mirrored terminal");
  // colour survives: herdr's read keeps the escape sequences
  await page.keyboard.type("printf '\\033[31mred-cell\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await until(async () => await page.locator(".xterm-rows span[class*='xterm-fg-1']", { hasText: "red-cell" }).count() > 0, "a red cell is painted red");
  if (evidence) await page.screenshot({ path: join(evidence, "windows-mirror-desktop.png") });
  console.log("PASS the terminal lens of a PC without attach shows the pane's screen, typed input included");

  // the chat lens and back: the mirror is still there, and the grid is the pane's own
  await page.getByRole("button", { name: /^Chat/ }).click();
  await terminal.click();
  await until(async () => (await screen(page)).includes("mirror-ok-42"), "the screen is back after a lens switch");
  console.log("PASS the mirrored screen survives a lens switch");

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const small = await phone.newPage();
  small.on("pageerror", (error) => errors.push(error.message));
  small.setDefaultTimeout(10_000);
  await small.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
  await until(async () => (await screen(small)).includes("mirror-ok-42"), "a second, phone-sized viewer gets the current screen");
  if (evidence) await small.screenshot({ path: join(evidence, "windows-mirror-phone.png") });
  console.log("PASS a phone-sized second viewer sees the same screen");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
