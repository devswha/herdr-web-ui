/** Production app + fictional demo transport. Receipts and transcript reads are controlled separately. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { AgentStatus, ClientMessage, ConversationTurn, PendingMessage, ServerMessage } from "../shared/protocol.ts";
import type { Machine } from "../shared/machines.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { appFaces } from "./app-faces.ts";

interface NavigationQA {
  turns: ConversationTurn[];
  older: ConversationTurn[];
  history: string;
  status: AgentStatus | undefined;
  reads: number;
  submits: Extract<ClientMessage, { type: "submit" }>[];
  emit: (message: ServerMessage) => void;
  refresh: () => Promise<void>;
}
declare global { interface Window { navigationQA: NavigationQA } }

/** Runs after the demo transport but before React; no production module is replaced. */
function installFixture(controlled: string): void {
  let socket: WebSocket | null = null;
  let events: EventSource | null = null;
  let hidden = false;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  window.navigationQA = {
    turns: [], older: [], history: "navigation-one", status: undefined, reads: 0, submits: [],
    emit: (message) => {
      if (message.type === "pane-status") {
        window.navigationQA.status = message.agent_status;
        events?.onmessage?.call(events, new MessageEvent("message", { data: JSON.stringify({ type: "machine-message", machine_id: "local", message }) }));
      }
      socket?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    },
    refresh: () => new Promise<void>((resolve) => {
      hidden = true; document.dispatchEvent(new Event("visibilitychange"));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        hidden = false; document.dispatchEvent(new Event("visibilitychange")); resolve();
      }));
    }),
  };
  const native = window.fetch;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") return native(input, init).then(async (response) => {
      const body: { machines: Machine[] } = await response.json();
      const status = window.navigationQA.status;
      if (status !== undefined) for (const machine of body.machines) {
        for (const pane of machine.snapshot?.panes ?? []) if (pane.pane_id === controlled) pane.agent_status = status;
      }
      return Response.json(body);
    });
    if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === controlled) {
      const qa = window.navigationQA;
      qa.reads++;
      return Promise.resolve(Response.json({
        source: "claude-transcript", history_id: qa.history,
        cursor: url.searchParams.has("before") || qa.older.length === 0 ? null : `${qa.history}:older`,
        turns: url.searchParams.has("before") ? qa.older : qa.turns,
      }));
    }
    return native(input, init);
  };
  window.WebSocket = new Proxy(window.WebSocket, {
    construct(Target, args) {
      const next: WebSocket = Reflect.construct(Target, args);
      socket = next;
      const send = next.send.bind(next);
      next.send = (data) => {
        const message: ClientMessage = JSON.parse(String(data));
        if (message.type === "submit" && message.pane_id === controlled) window.navigationQA.submits.push(message);
        else send(data);
      };
      return next;
    },
  });
  window.EventSource = new Proxy(window.EventSource, {
    construct(Target, args) {
      const next: EventSource = Reflect.construct(Target, args);
      events = next;
      return next;
    },
  });
}

/** Observe exact DOM changes with a bounded deadline; no timing sleeps or polling intervals. */
async function drawn(page: Page, selector: string, count = 1): Promise<void> {
  await page.evaluate(({ selector, count }) => new Promise<void>((resolve, reject) => {
    const matches = () => document.querySelectorAll(selector).length === count;
    if (matches()) { resolve(); return; }
    const observer = new MutationObserver(() => {
      if (matches()) { observer.disconnect(); clearTimeout(deadline); resolve(); }
    });
    const deadline = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM condition: ${selector} count=${count}`)); }, 10_000);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }), { selector, count });
}

const user = (text: string, ts: string): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }] });
const answer = (text: string, ts: string): ConversationTurn => ({ role: "assistant", ts, parts: [{ kind: "text", text }] });
const long = Array.from({ length: 24 }, (_, index) => `### Section ${index + 1}\n\nA fictional explanation long enough to read past the viewport. The original question remains available above the composer.`).join("\n\n");
const turns = [user("First prompt", "2026-10-09T00:00:00Z"), answer(long, "2026-10-09T00:00:01Z"),
  user("Latest prompt\n한국어 줄 바꿈", "2026-10-09T00:00:02Z"), answer(long, "2026-10-09T00:00:03Z")];
const repo = join(import.meta.dir, "..");
const evidence = join(repo, "evidence");
mkdirSync(evidence, { recursive: true });
const app = mkdtempSync(join(evidence, "navigation-app-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildDemoApp(app);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname.slice(1);
    if (path.includes("..") || path.includes("\\")) return new Response(null, { status: 400 });
    if (path === "" || path === "index.html") {
      const html = await Bun.file(join(app, "index.html")).text();
      return new Response(html.replace('<script type="module"', `<script src="/demo-transport.js"></script><script>(${installFixture.toString()})(${JSON.stringify(panes.docs)});</script><script type="module"`), { headers: { "content-type": "text/html" } });
    }
    return new Response(Bun.file(join(app, path)));
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  for (const mobile of [false, true]) for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({
      viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 3 : 1, locale: "en-US",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await context.addInitScript(({ pane, theme }) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ theme, language: "en", defaultView: "chat" }));
        localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
      }, { pane: panes.docs, theme });
      page.setDefaultTimeout(10_000);
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.docs)}&view=chat`);
      await drawn(page, ".composer-text");
      await page.evaluate(async (turns) => { window.navigationQA.turns = turns; await window.navigationQA.refresh(); }, turns);
      await drawn(page, ".chat-turn-user", 2);
      await appFaces(page, "Mg 한국어");
      await drawn(page, ".chat-back-to-prompt", 2);
      await page.locator(".composer-last-prompt").focus();
      await page.locator(".composer-last-prompt").press("Enter");
      assert.equal(await page.locator(".chat-turn-user:focus").getAttribute("data-turn"), "2");
      const geometry = await page.evaluate(() => {
        const bar = document.querySelector(".last-prompt-dock")!.getBoundingClientRect();
        const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
        const view = document.querySelector(".chat-view")!.getBoundingClientRect();
        const prompt = document.querySelector(".chat-turn-user:focus")!.getBoundingClientRect();
        return { bar, composer, view, prompt, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(geometry.bar.bottom <= geometry.composer.top, "bar clears the input and resize grip");
      assert.ok(Math.abs(geometry.bar.left - geometry.composer.left) <= 1 && Math.abs(geometry.bar.right - geometry.composer.right) <= 1, "same composer column");
      assert.ok(geometry.prompt.top >= geometry.view.top && geometry.prompt.top < geometry.view.top + 40, "jump aligns inside transcript");
      assert.equal(geometry.overflow, false);
      await page.screenshot({ path: join(evidence, `chat-navigation-${mobile ? "phone" : "desktop"}-${theme}.png`) });

      await page.locator(".chat-back-to-prompt").first().click();
      assert.equal(await page.locator(".chat-turn-user:focus").getAttribute("data-turn"), "0", "old answer returns to its own question");
      await page.evaluate(async () => { window.navigationQA.older = [{ role: "user", ts: "2026-10-08T00:00:00Z", parts: [{ kind: "text", text: "Older page" }] }]; await window.navigationQA.refresh(); });
      await drawn(page, ".chat-older");
      await page.locator(".chat-older").click();
      await drawn(page, ".chat-turn-user", 3);
      await page.locator(".composer-last-prompt").click();
      assert.equal(await page.locator(".chat-turn-user:focus").getAttribute("data-turn"), "3", "prepended history reindexes the target");
      // The header's real switch opens the terminal; the line opens Chat at the recorded prompt.
      await page.locator(".view-switch button").nth(1).click();
      await drawn(page, ".terminal-last-prompt");
      await page.locator(".terminal-last-prompt").click();
      await drawn(page, ".chat-turn-user:focus");
      assert.equal(await page.locator(".terminal-last-prompt").count(), 0, "terminal line unmounts beside the mobile terminal input");
      assert.equal(await page.locator(".chat-turn-user:focus").getAttribute("data-turn"), "2");

      // An unanswered send stays recoverable, and makes no transcript bubble or prompt preview.
      const text = page.locator(".composer-text");
      await text.fill("Unacknowledged draft");
      await page.locator(".composer-send").click();
      await drawn(page, '.composer-send[aria-busy="true"]');
      assert.equal(await text.inputValue(), "Unacknowledged draft");
      assert.equal(await page.locator(".chat-turn-user").count(), 2);
      assert.ok(!(await page.locator(".composer-last-prompt").textContent())?.includes("Unacknowledged"));
      assert.equal(await page.locator(".composer-send-progress").evaluate((node) => getComputedStyle(node).animationName), "none", "reduced motion keeps sending legible without spinning");
      await page.screenshot({ path: join(evidence, `chat-sending-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      await page.evaluate(() => {
        const qa = window.navigationQA, request = qa.submits.at(-1)!;
        qa.emit({ type: "submit-result", id: request.id, pane_id: request.pane_id, ok: false, code: "submit_timeout", message: "Uncertain fixture" });
      });
      await drawn(page, '.composer-send[aria-busy="false"]');
      assert.equal(await text.inputValue(), "Unacknowledged draft", "uncertain receipt retains draft");
      // The next accepted request is explicitly queued, not delivered.
      await page.evaluate((pane) => window.navigationQA.emit({ type: "pane-status", pane_id: pane, agent_status: "working" }), panes.docs);
      await drawn(page, '.composer-status[data-status="working"]');
      await text.fill("Queued follow-up");
      await page.locator(".composer-send").click();
      await drawn(page, '.composer-send[aria-busy="true"]');
      await page.evaluate(() => {
        const qa = window.navigationQA, request = qa.submits.at(-1)!;
        if (request.delivery !== "queue") throw new Error("working Send must request queue delivery");
        const pending: PendingMessage = { id: "qa-pending", request_id: request.id, text: request.text, state: "queued", created_at: "2026-10-09T00:00:04Z" };
        qa.emit({ type: "submit-result", id: request.id, pane_id: request.pane_id, ok: true, pending });
      });
      await drawn(page, '.pending-message[data-state="queued"]');
      await drawn(page, '.composer-send[aria-busy="true"]', 0);
      assert.equal(await text.inputValue(), "");
      assert.equal(await page.locator(".chat-turn-user").count(), 2, "queue receipt is not a sent bubble");
      assert.equal(await page.locator(".chat-thinking").count(), 0, "queue receipt does not imply thinking");
      assert.ok(!(await page.locator(".composer-last-prompt").textContent())?.includes("Queued"));
      await page.evaluate((pane) => {
        const qa = window.navigationQA, request = qa.submits.at(-1)!;
        qa.emit({ type: "pending-messages", pane_id: pane, messages: [{ id: "qa-pending", request_id: request.id, text: request.text, state: "uncertain", created_at: "2026-10-09T00:00:04Z" }] });
      }, panes.docs);
      await drawn(page, '.pending-message[data-state="uncertain"]');
      assert.equal(await page.locator(".pending-message-send").count(), 0, "uncertain rows cannot be retried");
      assert.equal(await page.locator(".chat-turn-user").count(), 2);
      await page.evaluate((pane) => window.navigationQA.emit({ type: "pending-messages", pane_id: pane, messages: [], removed: [{ id: "qa-pending", outcome: "sent" }] }), panes.docs);
      await drawn(page, ".pending-message", 0);
      assert.equal(await page.locator(".chat-turn-user").count(), 2, "delivery still does not fabricate a transcript entry");

      await page.evaluate(async (pane) => {
        window.navigationQA.turns = [{ role: "user", ts: "2026-10-09T00:01:00Z", parts: [{ kind: "text", text: "Authoritative prompt" }] }];
        window.navigationQA.emit({ type: "pane-status", pane_id: pane, agent_status: "working" });
        await window.navigationQA.refresh();
      }, panes.docs);
      await drawn(page, ".chat-thinking");
      assert.equal(await page.locator(".chat-thinking-dots i").first().evaluate((node) => getComputedStyle(node).animationName), "none");
      await page.screenshot({ path: join(evidence, `chat-thinking-${mobile ? "phone" : "desktop"}-${theme}.png`) });
      await page.evaluate(async () => {
        window.navigationQA.turns.push({ role: "assistant", ts: "2026-10-09T00:01:01Z", parts: [{ kind: "text", text: "Short answer" }] });
        await window.navigationQA.refresh();
      });
      await drawn(page, ".chat-thinking", 0);
      assert.equal(await page.locator(".chat-back-to-prompt").count(), 0, "short answers need no return control");

      await page.evaluate(async () => { window.navigationQA.history = "navigation-cleared"; window.navigationQA.turns = []; window.navigationQA.older = []; await window.navigationQA.refresh(); });
      await drawn(page, ".chat-turn-user", 0);
      await drawn(page, ".last-prompt", 0);
      assert.equal(await page.locator(".chat-back-to-prompt").count(), 0, "replaced history has no old target");
      assert.deepEqual(errors, []);
      console.log(`PASS ${mobile ? "phone" : "desktop"} ${theme}: navigation, prepend, terminal handoff, draft recovery, queue/delivery separation, history reset`);
    } catch (error) {
      console.error("Navigation fixture failure", await page.evaluate(() => ({
        turns: document.querySelectorAll(".chat-turn-user").length,
        lines: [...document.querySelectorAll(".last-prompt")].map((node) => ({ class: node.className, text: node.textContent })),
        source: window.navigationQA.turns, reads: window.navigationQA.reads, history: window.navigationQA.history,
      })), errors);
      await page.screenshot({ path: join(evidence, "chat-navigation-failure.png") });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
