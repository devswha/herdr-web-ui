/** Real composer and bridge on a disposable raw-input recorder; no live user's panes. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-steering-browser-"));
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let step = "startup";
let debug = async () => {};
const until = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("steering browser condition timed out: " + step); await Bun.sleep(25); }
};
try {
  const executable = join(root, "claude"); copyFileSync(Bun.which("node")!, executable); chmodSync(executable, 0o755);
  const log = join(root, "input.jsonl");
  writeFileSync(join(root, "record.cjs"), `const fs=require("node:fs");process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h› Message\\r\\n",()=>fs.writeFileSync(process.argv[2],""));process.stdin.on("data",c=>fs.appendFileSync(process.argv[2],JSON.stringify(c.toString("utf8"))+"\\n"));`);
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { cwd: root, label: "herdr-web-ui-test-steering-browser", focus: false });
  workspace = created.workspace.workspace_id; const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${executable}' '${join(root, "record.cjs")}' '${log}'\n` });
  await until(() => existsSync(log));
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), args: ["--no-sandbox"], headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", steerImmediately: true, enterSends: true, showQuickReplies: true, quickReplies: ["Quick steering"], alertsOn: false }));
  });
  const page = await context.newPage(); page.setDefaultTimeout(10_000); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  let loseAck = false;
  let inputReady = false;
  const submits: Array<{ text: string; delivery?: string; steering_id?: string }> = [];
  page.on("websocket", (ws) => ws.on("framesent", ({ payload }) => { const frame = JSON.parse(String(payload)); if (frame.type === "submit") submits.push(frame); }));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "input-ready" && frame.pane_id === pane && frame.ready !== false) inputReady = true;
      if (loseAck && frame.type === "submit-result") { loseAck = false; inputReady = false; void socket.close(); }
      else socket.send(message);
    });
  });
  debug = async () => { console.log(JSON.stringify({ step, inputReady, submits, errors, value: await page.locator(".composer-text").inputValue(), body: await page.locator(".terminal-stack").innerText() }));  };
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const box = page.locator(".composer-text"); await box.waitFor(); await page.locator(".conn-live").waitFor(); await until(() => inputReady);
  const submit = async (text: string, button = false) => {
    step = "submit " + text;
    await box.fill(text);
    if (button) await page.getByRole("button", { name: "Send message", exact: true }).click(); else await box.press("Enter");
    await until(async () => await box.inputValue() === "");
    await until(() => bytes().includes(text));
  };
  await submit("Enter steering"); assert.equal(submits.length, 1); assert.equal(submits[0]!.delivery, "steer");
  assert.equal(await page.locator(".pending-message").count(), 0);
  await submit("Button steering", true); assert.equal(submits.length, 2);
  step = "quick";
  await page.getByRole("button", { name: "Quick steering", exact: true }).click(); await until(() => bytes().includes("Quick steering"));
  assert.equal(submits.length, 3); assert(submits.every((frame) => frame.delivery === "steer"));
  await box.fill("multiline"); await box.press("Shift+Enter"); await box.press("m");
  assert.equal(await box.inputValue(), "multiline\nm"); assert.equal(submits.length, 3);
  await box.fill(""); await box.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  await box.dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 13 });
  assert.equal(submits.length, 3);
  await cdp.send("Input.insertText", { text: "한" }); await cdp.detach();
  await submit("pasted line one\nline two"); assert.equal(submits.length, 4);
  await box.fill("Double Enter"); await box.press("Enter"); await box.press("Enter");
  await until(async () => await box.inputValue() === ""); assert.equal(submits.length, 5);
  // Real upload path: attachment mention survives the one-action steering submission.
  step = "attachment";
  await page.locator('input[type="file"]').setInputFiles({ name: "steering.txt", mimeType: "text/plain", buffer: Buffer.from("owned test attachment") });
  await page.getByText("Attached", { exact: true }).waitFor();
  await until(async () => (await box.inputValue()).includes("/.herdr-web-ui/steering-"));
  const attached = await box.inputValue(); await box.press("Enter"); await until(async () => await box.inputValue() === "");
  assert(submits[5]!.text.includes("/.herdr-web-ui/steering-")); assert(bytes().includes(attached.trimEnd()));
  // Lost acknowledgement: nothing automatically repeats; explicit retry replays the durable receipt.
  step = "lost acknowledgement";
  loseAck = true; await box.fill("Acknowledgement lost"); await box.press("Enter");
  await page.locator('.pending-message[data-state="uncertain"]').waitFor();
  const uncertain = submits[6]!; const delivered = bytes();
  await page.locator(".conn-live").waitFor(); await until(() => inputReady);
  inputReady = false; await page.reload(); await box.waitFor(); await until(() => inputReady);
  assert.equal(submits.length, 7, "reload never replays a saved message");
  step = "retry lost acknowledgement";
  const retry = page.getByRole("button", { name: "Send now: Acknowledgement lost", exact: true });
  await until(async () => await retry.isEnabled()); await retry.click();
  await until(async () => await page.locator(".pending-message").count() === 0);
  assert.equal(submits[7]!.steering_id, uncertain.steering_id); assert.equal(bytes(), delivered);
  step = "queue preference";
  // Saved preference is respected; the deliberately queued route remains available.
  await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem("herdr-web-ui:settings")!); saved.steerImmediately = false; localStorage.setItem("herdr-web-ui:settings", JSON.stringify(saved)); });
  inputReady = false; await page.reload(); await box.waitFor(); await page.locator(".conn-live").waitFor(); await until(() => inputReady);
  await box.fill("deliberate next turn"); await box.press("Enter");
  await page.locator('.pending-message[data-state="queued"]').waitFor(); assert.equal(submits.at(-1)!.delivery, "queue");
  assert(!bytes().includes("deliberate next turn"));
  // Touch/mobile sends use the same handler and leave Shift+Enter and paste semantics alone.
  await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem("herdr-web-ui:settings")!); saved.steerImmediately = true; localStorage.setItem("herdr-web-ui:settings", JSON.stringify(saved)); });
  inputReady = false; await page.reload(); await page.setViewportSize({ width: 390, height: 844 }); await box.waitFor(); await page.locator(".conn-live").waitFor(); await until(() => inputReady);
  await submit("Mobile steering", true); assert.equal(submits.at(-1)!.delivery, "steer");
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS Enter, Send, quick replies, Shift+Enter, IME, multiline, double Enter, attachment, lost ACK retry, opt-out queue and mobile controls");
} catch (error) { await debug(); throw error; } finally {
  await browser?.close(); server?.stop();
  if (workspace) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
