import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The copies inside an opened tool call, on the production client over the demo's fixture
// transport: one demo pane answers with the calls below, and the whole output of the cut one is
// served (or refused, or held) as the test says. The real browser clipboard is read back. All
// files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-tool-copy-demo-"));
const PANE = panes.flaky;

const PATCH_INPUT = "*** Begin Patch\n*** Update File: src/lib/retry.ts\n@@\n-    await sleep(delay);\n+    await clock.sleep(delay);   \n+\t\treturn attempt;\n*** End Patch\n";
const PATCH_OUTPUT = "Success. Updated the following files:\nM src/lib/retry.ts\n";
const TODO_INPUT = JSON.stringify({ op: "start", task: "Write the test" }, null, 2);
const TODO_OUTPUT = "  Setup:\n    - [X] Read the plan\n    - [ ] Write the test (in progress)\n";
const WHOLE = Array.from({ length: 120 }, (_, index) => `  ok ${index + 1} retries a timed-out upload  `).join("\n") + "\n";
const PREVIEW = WHOLE.slice(0, 400);
const ERROR_OUTPUT = "error: expected 3 attempts, received 2\n    at retry.test.ts:14:5\n";

const tool = (name: string, summary: string, input: string, output: string, extra: Record<string, unknown> = {}) => ({ kind: "tool", name, summary, input, output, ...extra });
const PARTS = [
  tool("apply_patch", "src/lib/retry.ts", PATCH_INPUT, PATCH_OUTPUT),
  tool("todo", "Write the test", TODO_INPUT, TODO_OUTPUT),
  tool("Bash", "bun test retry --rerun-each 120", JSON.stringify({ command: "bun test retry --rerun-each 120" }), PREVIEW, { output_ref: "whole-1", output_size: WHOLE.length }),
  tool("Bash", "bun test retry", JSON.stringify({ command: "bun test retry" }), ERROR_OUTPUT, { error: true }),
  tool("Write", "fixtures/big.json", "", "Created fixtures/big.json", { arguments_omitted: true }),
  tool("mystery_tool", "mystery_tool", "", "done"),
];
const CONVERSATION = {
  source: "claude-transcript", cursor: null, metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
  turns: [
    { role: "user", ts: "2026-09-25T09:07:00.000Z", parts: [{ kind: "text", text: "Fix the flaky retry test." }] },
    { role: "assistant", ts: "2026-09-25T09:07:04.000Z", end_ts: "2026-09-25T09:09:30.000Z", parts: [...PARTS, { kind: "text", text: "Fixed." }] },
  ],
};
const ROW = { patch: 0, todo: 1, cut: 2, error: 3, omitted: 4, empty: 5 } as const;

// Runs after the demo transport: this pane's conversation and the whole output are the test's.
// window.toolOutput: "ok" serves it, "fail" answers 500, "hold" waits for window.releaseOutput().
// window.denyClipboard refuses both the clipboard API and the copy command.
const hooks = `<script>(() => {
  const demo = window.fetch;
  window.toolOutput = "ok";
  window.toolOutputReads = 0;
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(PANE)}) return Response.json(${JSON.stringify(CONVERSATION)});
    if (url.pathname === "/api/pane/conversation/tool-output") {
      window.toolOutputReads += 1;
      if (window.toolOutput === "fail") return Response.json({ error: { code: "fixture", message: "refused by the test" } }, { status: 500 });
      if (window.toolOutput === "hold") await new Promise((done) => { window.releaseOutput = done; });
      return new Response(${JSON.stringify(WHOLE)});
    }
    return demo(input, init);
  };
  window.denyClipboard = false;
  const write = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (text) => window.denyClipboard ? Promise.reject(new DOMException("refused by the test", "NotAllowedError")) : write(text);
  const exec = document.execCommand.bind(document);
  document.execCommand = (...args) => window.denyClipboard ? false : exec(...args);
  // whether any tool copy ever said Copied, however briefly
  window.sawCopied = false;
  new MutationObserver(() => { if (document.querySelector(".chat-tool-copy.is-copied")) window.sawCopied = true; })
    .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
})();</script>`;

const row = (page: Page, index: number): Locator => page.locator(".work-row").nth(index);
const copyOf = (scope: Locator): Locator => scope.locator(".chat-tool-copy");
const clipboard = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
const reads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { toolOutputReads: number }).toolOutputReads);

/** Every Copied has gone back to its label (the button says it for a moment after a copy). */
const rested = (page: Page): Promise<unknown> => page.waitForFunction(() => document.querySelector(".chat-tool-copy.is-copied") === null);

const open = async (page: Page, index: number): Promise<Locator> => {
  const target = row(page, index);
  const head = target.locator(".work-row-head");
  if (await head.getAttribute("aria-expanded") !== "true") await head.click();
  await target.locator(".work-row-detail").waitFor();
  return target;
};

/** Clicks a copy and waits for its own answer: Copied on success, the row's alert on a refusal. */
const copy = async (page: Page, button: Locator): Promise<string> => {
  // held by element: the button's name turns to Copied once it has copied
  const handle = (await button.elementHandle())!;
  // a Copied left from an earlier press must not be taken for this one's
  await page.waitForFunction((node) => !node.classList.contains("is-copied"), handle);
  await page.evaluate(() => navigator.clipboard.writeText("<sentinel>"));
  await handle.click();
  await page.waitForFunction((node) => node.classList.contains("is-copied"), handle);
  return clipboard(page);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${hooks}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) {
        const width = phone ? 390 : 1440;
        const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 3 : 1, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const block = page.locator(".work-block-head").first();
          await block.waitFor();
          if (await block.getAttribute("aria-expanded") === "false") await block.click();
          await row(page, ROW.empty).waitFor();
          assert.equal(await page.locator(".chat-tool-copy").count(), 0, "a folded row has no copy controls");

          // raw input retains whitespace
          const patch = await open(page, ROW.patch);
          assert.equal(await reads(page), 0, "opening a row loads nothing");
          assert.deepEqual(await copyOf(patch).allTextContents(), ["Copy input", "Copy output"]);
          assert.equal(await copy(page, copyOf(patch).first()), PATCH_INPUT, "raw input retains whitespace: the patch as sent, not its drawn diff");
          assert.equal(await copy(page, copyOf(patch).last()), PATCH_OUTPUT, "a complete output copies as it is, its last newline included");

          // a todo call shows its list, but the copies are its raw input and answer
          const todo = await open(page, ROW.todo);
          await todo.locator(".todo-list").waitFor();
          assert.equal(await todo.locator(".chat-tool-output pre").count(), 0, "the list stays the only view of the answer");
          assert.deepEqual(await copyOf(todo).allTextContents(), ["Copy input", "Copy output"]);
          assert.equal(await copy(page, copyOf(todo).first()), TODO_INPUT);
          assert.equal(await copy(page, copyOf(todo).last()), TODO_OUTPUT, "a todo answer's raw text is copied though the view leaves it out");

          // reference without loaded output is partial
          const cut = await open(page, ROW.cut);
          assert.equal(await reads(page), 0, "opening a cut output does not fetch its rest");
          const partial = cut.getByRole("button", { name: "Copy partial output", exact: true });
          assert.equal(await copy(page, partial), PREVIEW, "reference without loaded output is partial: the preview, named as part");
          await rested(page);
          await page.evaluate(() => { (window as unknown as { toolOutput: string }).toolOutput = "hold"; });
          await cut.locator(".chat-tool-more").click();
          await cut.getByRole("button", { name: "Loading the whole output…" }).waitFor();
          assert.equal(await partial.count(), 1, "while the rest loads the copy still says partial");
          await page.evaluate(() => { (window as unknown as { toolOutput: string; releaseOutput: () => void }).toolOutput = "fail"; (window as unknown as { releaseOutput: () => void }).releaseOutput(); });
          // the held answer is the whole output: it arrives and the scope changes only now
          const whole = cut.getByRole("button", { name: "Copy whole output", exact: true });
          await whole.waitFor();
          assert.equal(await cut.locator(".chat-tool-io.is-whole").textContent(), WHOLE);
          assert.equal(await copy(page, whole), WHOLE, "loaded whole output replaces preview");
          assert.equal(await reads(page), 1);
          console.log(`PASS ${width}: exact raw input/output copies; partial until the whole output loads, then whole`);

          // the error row copies its error text
          const failed = await open(page, ROW.error);
          assert.equal(await failed.locator(".chat-tool-output h4").textContent(), "Error");
          assert.equal(await copy(page, copyOf(failed).last()), ERROR_OUTPUT);

          // omitted input cannot claim raw copy; an empty one keeps a disabled copy
          const omitted = await open(page, ROW.omitted);
          assert.equal(await omitted.locator(".chat-tool-input .chat-tool-io").textContent(), "Arguments omitted (too large)", "the omission stays explained");
          assert.equal(await omitted.getByRole("button", { name: /input/i }).count(), 0, "omitted input cannot claim raw copy");
          assert.deepEqual(await copyOf(omitted).allTextContents(), ["Copy output"]);
          const empty = await open(page, ROW.empty);
          assert.equal(await empty.getByRole("button", { name: "Copy input", exact: true }).isDisabled(), true, "an empty input's copy is disabled");
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}: error output, omitted input explained without a copy, empty input disabled`);
        } finally { await context.close(); }
      }

      // partial-and-denied: a failed load keeps the partial copy truthful, retry succeeds, and a
      // refused clipboard says so and never shows Copied
      {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        try {
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`);
          const block = page.locator(".work-block-head").first();
          await block.waitFor();
          if (await block.getAttribute("aria-expanded") === "false") await block.click();
          const cut = await open(page, ROW.cut);
          await page.evaluate(() => { (window as unknown as { toolOutput: string }).toolOutput = "fail"; });
          await cut.locator(".chat-tool-more").click();
          await cut.getByRole("button", { name: "Couldn't load the whole output — retry" }).waitFor();
          const partial = cut.getByRole("button", { name: "Copy partial output", exact: true });
          assert.equal(await copy(page, partial), PREVIEW, "after a failed load the preview stays copyable as partial");
          await rested(page);
          assert.equal(await page.locator(".chat-tool-copy:not([aria-label^='Copy partial']):not([aria-label^='Copy input'])").count(), 0, "nothing claims the whole output");

          await page.evaluate(() => { const w = window as unknown as { denyClipboard: boolean; sawCopied: boolean }; w.denyClipboard = true; w.sawCopied = false; });
          await page.evaluate(() => navigator.clipboard.readText()).then((text) => assert.equal(text, PREVIEW));
          await partial.click();
          await cut.getByRole("alert").filter({ hasText: "Couldn't copy. Select the text and copy it manually." }).waitFor();
          await cut.getByRole("button", { name: "Copy input", exact: true }).click();
          await cut.getByRole("alert").waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { sawCopied: boolean }).sawCopied), false, "a refused copy never shows Copied");
          assert.equal(await clipboard(page), PREVIEW, "a refused copy leaves the clipboard as it was");

          const omitted = await open(page, ROW.omitted);
          assert.equal(await omitted.locator(".chat-tool-input .chat-tool-io").textContent(), "Arguments omitted (too large)");

          await page.evaluate(() => { const w = window as unknown as { denyClipboard: boolean; toolOutput: string }; w.denyClipboard = false; w.toolOutput = "ok"; });
          await cut.getByRole("button", { name: "Couldn't load the whole output — retry" }).click();
          const whole = cut.getByRole("button", { name: "Copy whole output", exact: true });
          await whole.waitFor();
          assert.equal(await copy(page, whole), WHOLE, "retry loads the rest and the copy becomes whole");
          await cut.getByRole("alert").waitFor({ state: "detached" });
          console.log("PASS partial-and-denied: failed load keeps a partial copy, refused clipboard is said without Copied, retry copies whole");
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
