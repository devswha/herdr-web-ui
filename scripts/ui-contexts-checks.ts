import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { checkWakeLock } from "./wake-lock-regression.ts";
import { checkSecretInput } from "./secret-input-regression.ts";
import { checkTerminalCopy } from "./terminal-copy-regression.ts";
import { checkPaneFind } from "./pane-find-regression.ts";
import { checkNotificationStartup } from "./notification-startup-regression.ts";
import { checkAlertToggle, checkNotificationView } from "./notification-view-regression.ts";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { checkTerminalPinch } from "./terminal-pinch-regression.ts";
import { checkMobileTabs } from "./mobile-tabs-regression.ts";
import { checkTabMenu } from "./tab-menu-regression.ts";
import { checkDefaultView } from "./default-view-regression.ts";
import { checkComposerReconnect } from "./composer-reconnect-regression.ts";
import { checkDroplet } from "./droplet-regression.ts";
import { checkSplitView } from "./split-view-regression.ts";
import { checkTakeOver } from "./take-over-regression.ts";
import { checkAlertSound } from "./alert-sound-regression.ts";
import { checkBackgroundTabKeepsTerminalSize, checkChatKeepsTerminalSize, checkFocusedWindowReclaimsTerminalSize, checkPaneSwitchKeepsTerminalSize } from "./chat-size-regression.ts";
import { chromePath } from "./chrome-path.ts";

async function timed(name: string, check: () => Promise<void>): Promise<void> {
  const started = performance.now();
  let checkFailed = false;
  try {
    await check();
  } catch (error) {
    checkFailed = true;
    throw error;
  } finally {
    try {
      console.log(`TIMING ${name} seconds=${((performance.now() - started) / 1000).toFixed(3)}`);
    } catch (error) {
      if (!checkFailed) throw error;
    }
  }
}

function isWorkspaceMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "workspace_not_found";
}

/** A failed local session read disables workstation actions until a successful retry. */
export async function checkLocalSessionAvailability(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    });
    const page = await context.newPage();
    let unavailable = false;
    await page.route("**/api/events", (route) => route.abort());
    await page.route("**/api/session", (route) => unavailable
      ? route.fulfill({ status: 503, json: { error: { code: "herdr_unavailable", message: "Workstation is unavailable" } } })
      : route.continue());
    await page.goto(origin);
    await page.locator(".machine-name").waitFor();
    assert.equal(await page.locator(".machine-new").isEnabled(), true);
    unavailable = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("alert").filter({ hasText: "Workstation is unavailable" }).waitFor();
    await page.locator(".machine-group.is-offline").waitFor({ timeout: 4000 });
    assert.equal(await page.locator(".machine-new").isDisabled(), true, "unavailable herdr cannot create a workspace");
    unavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator(".machine-group.is-offline").waitFor({ state: "detached" });
    assert.equal(await page.locator(".machine-new").isEnabled(), true, "a successful local read restores workstation actions");
    assert.equal((await page.locator(".machine-title").innerText()).trim(), "Host", "the local workstation name is not duplicated by a Host badge");
    await page.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}");
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, language: "ja" }));
    });
    await page.reload();
    await page.getByText("ホスト", { exact: true }).waitFor();
    assert.equal((await page.locator(".machine-title").innerText()).trim(), "ホスト", "the local name follows the interface language");
    console.log("PASS local workstation identity is localized once; failed session reads disable actions and retry restores them");
  } finally { await context.close(); }
}

export async function runUiContextChecks(): Promise<void> {
  const tempBase = existsSync("/tmp") ? "/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(tempBase, "hwc-")));
  const workspaces: string[] = [];
  const cleanupErrors: unknown[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  let failed = false;
  let failure: unknown;

  try {
    const cwdA = join(root, "a");
    const cwdB = join(root, "b");
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    const createdA = await workspaceCreate({ cwd: cwdA, label: "herdr-web-ui-contexts-a" });
    workspaces.push(createdA.workspace.workspace_id);
    const createdB = await workspaceCreate({ cwd: cwdB, label: "herdr-web-ui-contexts-b" });
    workspaces.push(createdB.workspace.workspace_id);
    const paneA = createdA.root_pane.pane_id;
    const paneB = createdB.root_pane.pane_id;
    await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });

    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: ["--no-sandbox", "--accept-lang=en-US"],
    });

    await timed("checkLocalSessionAvailability", () => checkLocalSessionAvailability(browser!, origin));
    await timed("checkAlertToggle", () => checkAlertToggle(browser!, origin));
    await timed("checkWakeLock", () => checkWakeLock(browser!, origin, paneA));
    await timed("checkSecretInput", () => checkSecretInput(browser!, origin));
    await timed("checkTerminalCopy", () => checkTerminalCopy(browser!, origin));
    await timed("checkPaneFind", () => checkPaneFind(browser!, origin));
    await timed("checkNotificationStartup", () => checkNotificationStartup(browser!, origin, paneA, paneB));
    await timed("checkNotificationView", () => checkNotificationView(browser!, origin));
    await timed("checkMobileViewport", () => checkMobileViewport(browser!, origin, paneB));
    await timed("checkTerminalPinch", () => checkTerminalPinch(browser!, origin, paneB));
    await timed("checkMobileTabs", () => checkMobileTabs(browser!, origin));
    await timed("checkTabMenu", () => checkTabMenu(browser!, origin));
    await timed("checkDefaultView", () => checkDefaultView(browser!, origin));
    await timed("checkComposerReconnect", () => checkComposerReconnect(browser!, origin, paneB));
    await timed("checkDroplet", () => checkDroplet(browser!, origin));
    await timed("checkSplitView", () => checkSplitView(browser!, origin));
    await timed("checkTakeOver", () => checkTakeOver(browser!, origin));
    await timed("checkAlertSound", () => checkAlertSound(browser!, origin));
    await timed("checkChatKeepsTerminalSize", () => checkChatKeepsTerminalSize(browser!, origin));
    await timed("checkPaneSwitchKeepsTerminalSize", () => checkPaneSwitchKeepsTerminalSize(browser!, origin));
    await timed("checkBackgroundTabKeepsTerminalSize", () => checkBackgroundTabKeepsTerminalSize(browser!, origin));
    await timed("checkFocusedWindowReclaimsTerminalSize", () => checkFocusedWindowReclaimsTerminalSize(browser!, origin));
  } catch (error) {
    failed = true;
    failure = error;
  }

  if (browser) {
    try { await browser.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (server) {
    try { server.stop(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const workspace of workspaces) {
    try { await workspaceClose(workspace); } catch (error) { if (!isWorkspaceMissing(error)) cleanupErrors.push(error); }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }

  if (failed) {
    if (cleanupErrors.length) console.error(new AggregateError(cleanupErrors, "UI context fixture cleanup failed after the check failed"));
    throw failure;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "UI context fixture cleanup failed");
}
