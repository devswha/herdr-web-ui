/** Send while an agent works types the message in at once: leaving the pane before the turn ends cannot hold it (#874). */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";

type SubmitResult = Extract<ServerMessage, { type: "submit-result" }>;

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-send-working-")));
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}
try {
  const owner = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-send-working" });
  workspaces.push(owner.workspace.workspace_id);
  const away = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-send-working-away" });
  workspaces.push(away.workspace.workspace_id);
  const pane = owner.root_pane.pane_id;
  // a foreground program named for the agent records every byte the pane receives
  const windows = process.platform === "win32";
  const program = join(root, windows ? "claude.exe" : "claude");
  const script = join(root, "record.cjs");
  const log = join(root, "input.jsonl");
  copyFileSync(process.execPath, program); chmodSync(program, 0o755);
  writeFileSync(script, `const fs=require("node:fs");const out=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(out,""));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));`);
  // a Windows pane runs PowerShell, which has no exec
  await herdrRpc("pane.send_text", { pane_id: pane, text: windows ? `& '${program}' '${script}' '${log}'\r` : `exec '${program}' '${script}' '${log}'\n` });
  await until(() => existsSync(log), "the stand-in agent records input");
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  // a bounded watch, checked throughout, proves that nothing more is typed
  const noBytes = async (expected: string, label: string): Promise<void> => {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) { assert.equal(bytes(), expected, label); await Bun.sleep(25); }
    assert.equal(bytes(), expected, label);
  };
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const received: ServerMessage[] = [];
  const statuses = new Map<string, string>();
  const ready = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ClientMessage;
      if (frame.type === "attach" || frame.type === "detach") ready.delete(frame.pane_id);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ServerMessage;
      received.push(frame);
      if (frame.type === "snapshot") for (const item of frame.snapshot.panes) statuses.set(item.pane_id, item.agent_status);
      if (frame.type === "pane-status") statuses.set(frame.pane_id, frame.agent_status);
      if (frame.type === "input-ready") {
        if (frame.ready !== false) ready.add(frame.pane_id); else ready.delete(frame.pane_id);
      }
    });
  });
  const current = (id: string) => page.locator(`[data-layout-pane=${JSON.stringify(id)}]`).and(page.locator(".is-current"));
  const inputReady = (id: string) => until(() => ready.has(id), `${id} takes input`);
  const selectWorkspace = async (id: string, selectedPane: string): Promise<void> => {
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(id)}] .pane-select`).click();
    await current(selectedPane).waitFor();
    await inputReady(selectedPane);
  };
  const report = async (state: "working" | "idle"): Promise<void> => {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await until(() => state === "idle" ? ["idle", "done"].includes(statuses.get(pane) ?? "") : statuses.get(pane) === state, `the bridge reports ${state}`);
  };
  const send = async (text: string): Promise<SubmitResult> => {
    await current(pane).locator('.composer-status[data-status="working"]').waitFor();
    await inputReady(pane);
    const after = received.length;
    await current(pane).getByRole("textbox", { name: "Message", exact: true }).fill(text);
    await current(pane).getByRole("button", { name: "Send message", exact: true }).click();
    const answer = (): SubmitResult | undefined => received.slice(after).find((frame): frame is SubmitResult => frame.type === "submit-result" && frame.pane_id === pane);
    await until(() => answer() !== undefined, "the server answers the Send");
    return answer()!;
  };
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await current(pane).waitFor(); await inputReady(pane);

  // The issue's steps: Send during the turn, go to another workspace, the turn ends, come back.
  // Typed in at once, the message is the agent's: nothing is left for a lost lease to hold.
  const text = "follow-up sent while the agent works";
  const typed = await send(text);
  await selectWorkspace(away.workspace.workspace_id, away.root_pane.pane_id);
  await report("idle");
  await selectWorkspace(owner.workspace.workspace_id, pane);
  await until(() => bytes().includes(text), "the message reached the agent rather than a list the pane switch held");
  assert.equal(typed.ok, true, JSON.stringify(typed));
  assert.equal(typed.pending, undefined, "Send typed the message in, not into the bridge's queue");
  assert.equal(bytes().split(text).length - 1, 1, "typed exactly once");
  assert.ok(bytes().endsWith("\r"), "and committed with Enter");
  assert.equal(await current(pane).locator(".pending-message").count(), 0, "nothing waits under the message box");
  await report("working"); await report("idle");
  await noBytes(bytes(), "a later turn's end types nothing more");
  console.log("PASS Send while the agent works types the message in at once; a workspace switch and the turn's end cannot hold it");

  // Settings → Composer → Queue messages while the agent works brings back the bridge's queue,
  // with its own automatic-send switch beside it
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Chat");
  const automatic = page.getByRole("switch", { name: "Send queued messages automatically", exact: true });
  assert.equal(await automatic.count(), 0, "the queue's automatic-send switch shows only while queueing is on");
  await page.getByRole("switch", { name: "Queue messages while the agent works", exact: true }).click();
  await automatic.waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".settings-dialog").waitFor({ state: "detached" });
  await report("working");
  const before = bytes();
  const queued = await send("follow-up queued for the next turn");
  assert.ok(queued.ok && queued.pending, JSON.stringify(queued));
  const row = current(pane).locator(".pending-message").filter({ hasText: queued.pending.text });
  await row.waitFor();
  assert.equal(await row.getAttribute("data-state"), "queued");
  await noBytes(before, "a queued message is not typed while the turn runs");
  await row.getByRole("button", { name: "Discard", exact: true }).click();
  await row.waitFor({ state: "detached" });
  await noBytes(before, "a discarded message is never typed");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS with Queue messages while the agent works on, Send waits in the bridge's queue for the next turn");
} finally {
  await browser?.close(); server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
