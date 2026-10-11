/** Real ChatView with an unavailable conversation and a stalled optional terminal. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { serveStatic } from "../server/static.ts";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-fallback-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-fallback-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  const terminalReads: string[] = [];
  let structured = false, resolveAgent!: () => void;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt: null });
    if (url.pathname === "/api/pane/conversation") return Response.json({ source: structured && pane === "agent" ? "codex-transcript" : "scrollback", cursor: null, turns: structured && pane === "agent" ? [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Structured conversation arrived" }] }] : [] });
    if (url.pathname === "/api/pane/read") {
      terminalReads.push(pane ?? "");
      const response = () => Response.json({ read: { text: pane === "shell" ? "Shell inline output" : "OLD AGENT TERMINAL", truncated: false } });
      if (pane === "agent") return new Promise<Response>((resolve) => { resolveAgent = () => resolve(response()); });
      return response();
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const summary = page.locator(".chat-terminal-fallback summary");
  await summary.waitFor();
  await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "detached" });
  assert.equal(terminalReads.length, 0, "a hidden terminal read cannot hold the initial chat");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-fallback-closed.png") });
  }
  const terminal = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pane/read");
  await summary.click(); await terminal;
  assert.ok(terminalReads.includes("agent"));
  structured = true;
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Structured conversation arrived", { exact: true }).waitFor();
  const nextKindRead = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pane/conversation", { timeout: 3_000 });
  await page.evaluate(() => window.chatFallbackQA.agent("claude"));
  await nextKindRead;
  resolveAgent();
  await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  assert.ok(!(await page.locator("body").innerText()).includes("OLD AGENT TERMINAL"));
  await page.evaluate(() => window.chatFallbackQA.pane("shell"));
  await page.getByText("Shell inline output", { exact: true }).waitFor();
  assert.ok(terminalReads.includes("shell"), "non-agent scrollback remains inline");
  assert.deepEqual(errors, []);
  console.log("chat fallback: browser OK (no hidden terminal reads, opened stalled output cannot block structured refresh, late cleanup and non-agent inline output)");

} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
