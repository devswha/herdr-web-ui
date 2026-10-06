import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Machine, SetupJob, SetupRequest } from "../shared/machines.ts";

// A built client with a fictional PC and in-memory API; no SSH or user sessions.
const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
const pc: Machine = { ...local, id: "qa-remote", name: "QA remote", kind: "ssh", target: { destination: "qa.invalid" } };
const requests: SetupRequest[] = [];
let conflict = false;
let job: SetupJob | null = null;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, auth: { authenticated: true, required: false, role: "drive" }, herdr: { version: "0.9.3", protocol: 22 }, web_ui: { revision: null, boot_id: "qa" } });
  if (path === "/api/machines") return Response.json({ machines: [local, pc] });
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path === "/api/machines/setup" && request.method === "POST") {
    const body = await request.json() as SetupRequest; requests.push(body);
    job = { id: "qa-job", machine_id: pc.id, target: pc.target!, phase: conflict ? "failed" : "connected", step: conflict ? "Connection failed" : "Connected", challenge: null, installations: [], error: conflict ? "Another app reconnected with a different version." : null, ssh_output: null, ...(conflict ? { action_required: "bridge_conflict" } : {}) };
    return Response.json(job, { status: 202 });
  }
  if (path === "/api/machines/setup/qa-job") return Response.json(job);
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
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.machine_id, pc.id); assert.equal(requests[0]!.update_remote, undefined);
  await page.screenshot({ path: `${shots}/connected.png` });
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  // A conflict after entering through Update bridge must not reinstall on retry.
  conflict = true;
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
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/conflict-mobile.png` });
  await dialog.getByRole("button", { name: "Reconnect", exact: true }).click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.at(-1)!.update_remote, undefined);
  assert.equal(await dialog.getByText("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: connected-PC reconnect, conflict notice, and retry without reinstall; screenshots:", shots);
} finally { await browser.close(); server.stop(true); }
