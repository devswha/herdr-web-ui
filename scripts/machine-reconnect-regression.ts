import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Machine, SetupJob, SetupRequest } from "../shared/machines.ts";
import { openSettingsPage } from "./settings-page.ts";

// A built client with a fictional PC and in-memory API; no SSH or user sessions.
const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
const pc: Machine = { ...local, id: "qa-remote", name: "QA remote", kind: "ssh", target: { destination: "qa.invalid" } };
const requests: SetupRequest[] = [];
let conflict = false;
let installing = false;
let jobMissing = false;
let job: SetupJob | null = null;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, auth: { authenticated: true, required: false, role: "drive" }, herdr: { version: "0.9.3", protocol: 22 }, web_ui: { revision: null, boot_id: "qa" } });
  if (path === "/api/machines") return Response.json({ machines: [local, pc] });
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path === "/api/machines/setup" && request.method === "POST") {
    const body = await request.json() as SetupRequest; requests.push(body);
    job = { id: "qa-job", machine_id: body.machine_id ?? "qa-new", target: { destination: body.destination }, phase: installing ? "approval" : conflict ? "failed" : "connected", step: installing ? "Review the changes on this PC" : conflict ? "Connection failed" : "Connected", challenge: null, installations: [], error: conflict ? "Another app reconnected with a different version." : null, ssh_output: null, ...(conflict ? { action_required: "bridge_conflict" } : {}) };
    return Response.json(job, { status: 202 });
  }
  if (path === "/api/machines/setup/qa-job") {
    if (jobMissing) return Response.json({ error: { code: "job_not_found", message: "Setup job not found" } }, { status: 404 });
    if (request.method === "POST") {
      const action = await request.json() as { action: string };
      if (action.action === "approve") job = { ...job!, phase: "installing", step: "Downloading the bridge", progress: { stage: "download", done: 25, total: 100, rate: 10, elapsed_ms: 1000 } };
      if (action.action === "cancel") job = { ...job!, phase: "cancelled", step: "Cancelled" };
    }
    return Response.json(job);
  }
  if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: { code: "qa", message: "Unavailable in fixture" } }, { status: 404 });
  const file = Bun.file(resolve("dist", path === "/" ? "index.html" : path.slice(1)));
  return new Response(await file.exists() ? file : Bun.file("dist/index.html"));
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env["CHROME_PATH"] || chromium.executablePath() });
const shots = resolve("evidence/machine-reconnect"); mkdirSync(shots, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  await page.goto(server.url.href);
  await page.getByRole("button", { name: "Reconnect QA remote", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Reconnect PC", exact: true });
  // A connected PC: the dialog says what reconnecting does before anything is sent.
  const warning = "This PC is connected. Reconnecting closes its open terminals in this app and attaches them again; sessions keep running and nothing you typed is sent again. If the new connection fails, the PC stays offline until you retry.";
  await dialog.getByText(warning, { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  await page.screenshot({ path: `${shots}/reconnect-warning.png` });
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.machine_id, pc.id); assert.equal(requests[0]!.update_remote, undefined);
  await page.screenshot({ path: `${shots}/connected.png` });
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  // A conflict after entering through Update bridge must not reinstall on retry.
  conflict = true;
  await page.locator(".machine-header").filter({ hasText: "QA remote" }).hover();
  await page.getByRole("button", { name: "Manage QA remote", exact: true }).click();
  await page.getByRole("button", { name: "Update bridge…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Update remote bridge", exact: true });
  await dialog.getByRole("button", { name: "Update bridge", exact: true }).click();
  await dialog.getByText("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.", { exact: true }).waitFor();
  assert.equal(requests[1]!.update_remote, true);
  await page.screenshot({ path: `${shots}/conflict.png` });
  conflict = false;
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests[2]!.update_remote, undefined);
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  pc.action_required = "bridge_conflict"; pc.state = "error"; pc.error = "Update this app, then reconnect.";
  await page.reload();
  await page.getByText("Bridge connection conflict", { exact: true }).waitFor();
  await page.getByText("QA remote has a bridge connection conflict.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Update bridge", exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".update-notice").getByRole("button", { name: "Reconnect", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Reconnect PC", exact: true });
  await dialog.waitFor();
  // nothing is attached on a PC that is not connected: no warning there
  assert.equal(await dialog.getByText(warning, { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/conflict-mobile.png` });
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.at(-1)!.update_remote, undefined);
  assert.equal(await dialog.getByText("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.", { exact: true }).count(), 0);
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  delete pc.action_required; pc.state = "connected"; pc.error = null;
  await page.reload();
  installing = true;
  // An update of a PC in the sidebar shows its progress on that PC's row: no entry of its own.
  await page.locator(".machine-header").filter({ hasText: "QA remote" }).hover();
  await page.getByRole("button", { name: "Manage QA remote", exact: true }).click();
  await page.getByRole("button", { name: "Update bridge…", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Update remote bridge", exact: true });
  await dialog.getByRole("button", { name: "Update bridge", exact: true }).click();
  pc.updating = { job_id: "qa-job", step: "Downloading the bridge", progress: null };
  await dialog.getByRole("button", { name: "Install and connect", exact: true }).click();
  await dialog.getByText("You can close this; the install keeps going and the sidebar shows it.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Continue in background", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "PC installations", exact: true }).count(), 0);
  delete pc.updating;
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Remote PCs");
  await page.getByRole("button", { name: "Add PC", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add PC", exact: true });
  await dialog.getByLabel("SSH alias or user@address").fill("new-pc.invalid");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.getByRole("button", { name: "Install and connect", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue in background", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const status = page.getByRole("button", { name: "PC installations", exact: true });
  // the list closes on a press outside it, as the other footer popovers do
  const showList = async () => { if (await status.getAttribute("aria-expanded") === "false") await status.click(); };
  await status.click();
  const progress = page.locator(".machine-setup-list");
  await progress.getByRole("progressbar").waitFor();
  assert.equal(await progress.getByRole("progressbar").getAttribute("aria-valuenow"), "25");
  job = { ...job!, progress: { ...job!.progress!, done: 75 } };
  await page.waitForFunction(() => document.querySelector('.machine-setup-list [role="progressbar"]')?.getAttribute("aria-valuenow") === "75");
  await page.screenshot({ path: `${shots}/background-install.png` });
  const beforeResume = requests.length;
  await progress.getByRole("button", { name: "Open PC setup" }).click();
  await dialog.getByRole("button", { name: "Continue in background" }).waitFor();
  assert.equal(requests.length, beforeResume);
  await dialog.getByRole("button", { name: "Continue in background" }).click();
  await showList();
  job = { ...job!, phase: "failed", step: "Connection failed", error: "Fixture download failed" };
  await progress.getByText("Fixture download failed", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#workspace-drawer")!.getBoundingClientRect().left >= -0.5);
  await showList();
  const panelBounds = await progress.boundingBox();
  assert.ok(panelBounds && panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/background-install-mobile.png` });
  await progress.getByRole("button", { name: "Open PC setup" }).click();
  await dialog.getByRole("button", { name: "Retry connection", exact: true }).click();
  await dialog.getByRole("button", { name: "Install and connect" }).click();
  await dialog.getByRole("button", { name: "Continue in background" }).click();
  await showList();
  job = { ...job!, phase: "connected", step: "Connected", error: null };
  await progress.getByText("Connected", { exact: true }).waitFor();
  await progress.getByRole("button", { name: "Dismiss", exact: true }).click();
  await status.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openSettingsPage(page, "Remote PCs");
  await page.getByRole("button", { name: "Add PC", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Add PC", exact: true });
  await dialog.getByLabel("SSH alias or user@address").fill("missing-job.invalid");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.getByRole("button", { name: "Install and connect", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue in background", exact: true }).click();
  jobMissing = true;
  await showList();
  await progress.getByText(/Setup job not found/).waitFor();
  // Escape closes the list and gives the focus back to its button
  await progress.getByRole("button", { name: "Dismiss", exact: true }).focus();
  await page.keyboard.press("Escape");
  assert.equal(await status.getAttribute("aria-expanded"), "false");
  assert.equal(await status.evaluate((el) => el === document.activeElement), true);
  await showList();
  await progress.getByRole("button", { name: "Dismiss", exact: true }).click();
  await status.waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS: reconnect, conflicts, background progress, resume, failure, retry, completion, missing job and mobile layout; screenshots:", shots);
} finally { await browser.close(); server.stop(true); }
