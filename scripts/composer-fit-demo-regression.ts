import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";

// The model label in the input card's last row, fitted to what is measured there, on the
// unmodified app over the demo's fixture transport. The demo's panes name no context window and
// run no task, so the page's data is patched here, in the test only: the pane is a Codex one with
// two background tasks, in the state a case asks for, and its conversation names that case's
// model, the level xhigh and a context window; an upload never answers, so its sentence stays.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
const LONG_MODEL = "gpt-5.6-sol-codex-preview-2026-10";

interface Case { model: string; status?: "working" | "idle"; mic?: boolean; ring?: boolean }
type Draw = "full" | "no-effort" | "out";

const measure = (page: Page) => page.evaluate(() => {
  const status = document.querySelector<HTMLElement>(".composer-status")!;
  const part = (selector: string) => {
    const item = document.querySelector<HTMLElement>(selector);
    if (!item) return null;
    const box = item.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, width: box.width, clipped: item.scrollWidth > item.clientWidth };
  };
  // everything drawn in the last row: no two of them may share a pixel
  const drawn = [...document.querySelectorAll<HTMLElement>(".composer-controls-left > *:not(input), .composer-status-meta > *, .composer-status-hint, .composer-controls-right > *")]
    .flatMap((item) => item.classList.contains("composer-model-info") && getComputedStyle(item).display === "contents" ? [...item.children] as HTMLElement[] : [item])
    .filter((item) => item.getBoundingClientRect().width > 1.5 && item.getBoundingClientRect().height > 1.5);
  const overlaps: string[] = [];
  for (const [index, one] of drawn.entries()) for (const other of drawn.slice(index + 1)) {
    const a = one.getBoundingClientRect(), b = other.getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${one.className} | ${other.className}`);
  }
  const surface = document.querySelector(".composer-surface")!.getBoundingClientRect();
  return {
    draw: status.getAttribute("data-model") ?? "full", hintAlone: status.hasAttribute("data-hint-alone"),
    card: { width: surface.width, height: surface.height }, status: status.getBoundingClientRect().height,
    label: part(".composer-model-info"), model: part(".composer-model"), effort: part(".composer-reasoning"), ring: part(".composer-context"), ringText: part(".composer-context-text"),
    hint: part(".composer-status-hint"), queue: document.querySelector(".composer-queue-button") !== null,
    chip: document.querySelector(".bg-tasks-toggle") !== null, mic: document.querySelector(".composer-controls-left .voice-mic") !== null,
    overlaps, overflowing: document.documentElement.scrollWidth > window.innerWidth,
  };
});
type Row = Awaited<ReturnType<typeof measure>>;

/** The fit answers after the commit, a resize a frame later: wait for the mark, never a fixed time. */
const drawn = async (page: Page, draw: Draw, what: string): Promise<Row> => {
  await page.waitForFunction((want) => (document.querySelector(".composer-status")?.getAttribute("data-model") ?? "full") === want, draw, { timeout: 5_000 })
    .catch(async () => assert.fail(`${what}: the model label is drawn "${(await measure(page)).draw}", not "${draw}": ${JSON.stringify(await measure(page))}`));
  const row = await measure(page);
  // a label that is drawn whole is whole; with Queue it is never drawn in part
  if (draw === "full" || row.queue) assert.ok(!row.model?.clipped && !row.effort?.clipped, `${what}: no word of the model label is cut: ${JSON.stringify(row)}`);
  if (draw === "no-effort") assert.ok((row.effort?.width ?? 0) <= 1, `${what}: the level is read, not drawn: ${JSON.stringify(row)}`);
  if (draw === "out") assert.ok((row.label?.width ?? 0) <= 1, `${what}: the name and the level are read, not drawn: ${JSON.stringify(row)}`);
  assert.deepEqual(row.overlaps, [], `${what}: nothing overlaps its neighbour`);
  assert.equal(row.overflowing, false, `${what}: the page does not scroll sideways`);
  return row;
};

const ring = (page: Page) => page.locator(".composer-context");
/**
 * Opens or closes the context number and answers how the label is drawn in that same task: React
 * commits a click in a microtask, and the label is fitted with that commit, not by whatever
 * renders the composer next (a poll, a status change), which no wait here would tell apart.
 */
const toggleRing = async (page: Page, open: boolean, draw?: Draw): Promise<void> => {
  const marked = await ring(page).evaluate(async (node: HTMLElement) => {
    node.click();
    await new Promise<void>((done) => queueMicrotask(done));
    return { open: node.getAttribute("aria-expanded"), draw: node.closest(".composer-status")!.getAttribute("data-model") ?? "full" };
  });
  assert.equal(marked.open, String(open));
  if (draw) assert.equal(marked.draw, draw, `the model label is fitted as the context number ${open ? "opens" : "closes"}`);
};
const draft = async (page: Page, queue: boolean): Promise<void> => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("hold this");
  if (queue) await page.locator(".composer-queue-button").waitFor();
};
const upload = async (page: Page): Promise<void> => {
  await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.locator(".composer-status-hint").waitFor();
  assert.equal(await page.locator(".composer-status-hint").textContent(), "· Uploading file…");
};

try {
  const build = Bun.spawnSync([join(repo, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo });
  assert.equal(build.exitCode, 0, new TextDecoder().decode(build.stderr));
  const transport = await Bun.build({
    entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app,
    naming: "demo-transport.js", target: "browser",
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version) },
  });
  assert.ok(transport.success, transport.logs.map(String).join("\n"));
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // What the demo answers, rewritten as it is read (`window.fitCase` is set per browser context).
  const patch = `<script>(() => {
    const TARGET = ${JSON.stringify(panes.api)};
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === TARGET && "agent_status" in value) {
        if ("agent" in value) Object.assign(value, { agent: "codex", background_tasks: 2 });
        value.agent_status = window.fitCase.status;
      }
      if (Array.isArray(value.turns) && value.metadata) value.metadata = { model: window.fitCase.model, reasoning_effort: "xhigh", ...(window.fitCase.ring ? { context: { used: 151000, window: 272000 } } : {}) };
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function () { return fix(await json.call(this)); };
    const demoFetch = window.fetch;
    window.fetch = (input, init) => String(typeof input === "string" ? input : input.url ?? input).includes("/pane/image") ? new Promise(() => {}) : demoFetch(input, init);
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${patch}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;

  /** One card: a phone (390px, touch) or a mouse-driven window of `width`. */
  const withCard = async (browser: Browser, width: number, state: Case, run: (page: Page) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch, locale: "en-US" });
    try {
      await context.addInitScript((fitCase) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: fitCase.mic }));
        Object.assign(window, { fitCase });
      }, { status: "working", mic: false, ring: true, ...state });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && message.text().includes("ResizeObserver")) errors.push(message.text()); });
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (await page.locator(".terminal-stack.is-chat").count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".composer-model").waitFor({ state: "attached" });
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  };

  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      // The context ring's number opens inside the row and the card keeps its size: the label is
      // fitted again. With Queue it steps out whole and comes back when the number closes
      for (const model of ["gpt-5.6", "gpt-5.6-sol"]) await withCard(browser, 390, { model }, async (page) => {
        await draft(page, true);
        const closed = await drawn(page, "full", `${model}, a draft`);
        assert.ok(closed.chip && closed.ring, "the task chip and the context ring are in the row");
        await toggleRing(page, true, "out");
        const open = await drawn(page, "out", `${model}, a draft, the context number open`);
        assert.equal(open.ringText?.clipped, false, `the number has the room the label left: ${JSON.stringify(open)}`);
        assert.equal(open.card.height, closed.card.height);
        await toggleRing(page, false, "full");
        await drawn(page, "full", `${model}, a draft, the context number closed again`);
      });
      console.log("PASS on a phone with Queue showing, opening the context number steps the model label out whole, and closing it brings the label back");

      // without Queue the level alone steps out, and no sliver of it is left beside the number
      await withCard(browser, 390, { model: "gpt-5.6-sol", status: "idle" }, async (page) => {
        await drawn(page, "full", "a resting pane");
        await toggleRing(page, true, "no-effort");
        const open = await drawn(page, "no-effort", "a resting pane, the context number open");
        assert.equal(open.model?.clipped, false, `the name is whole: ${JSON.stringify(open)}`);
        await toggleRing(page, false, "full");
        await drawn(page, "full", "a resting pane, the context number closed again");
      });
      console.log("PASS without Queue, opening the context number steps the level out whole and keeps the name");

      // The uploading sentence takes a line of its own and is shown whole; the rest stays one
      // row, so a label that does not fit there steps out as it does without the sentence, and
      // the mark, the name and the level never take a line each. 80px: the attachment strip
      for (const model of ["gpt-5.6", "gpt-5.6-sol-max", LONG_MODEL]) for (const number of [false, true]) await withCard(browser, 390, { model, mic: true }, async (page) => {
        await draft(page, true);
        if (number) await toggleRing(page, true);
        const before = await drawn(page, "out", `${model}, the mic and a draft`);
        assert.ok(before.mic && before.chip, "the mic and the task chip are in the row");
        await upload(page);
        const row = await drawn(page, "out", `${model}, the mic, a draft and an upload`);
        assert.ok(row.hintAlone && row.hint !== null && !row.hint.clipped, `the sentence is whole on its own line: ${JSON.stringify(row)}`);
        assert.ok(row.hint.top >= row.ring!.bottom - 0.5, `the sentence is under the ring: ${JSON.stringify(row)}`);
        assert.equal(row.status, before.status, `the status content keeps its height: ${JSON.stringify(row)}`);
        assert.ok(row.card.height - before.card.height <= 80.5, `the card grows by the attachment strip alone: ${row.card.height - before.card.height}px`);
      });
      console.log("PASS on a phone with the mic, a task chip, a draft and a pending upload, the model label stays stepped out and the sentence is whole on its own line");

      // a resting pane: a short label stays whole over the sentence; a long name gives up its
      // level and is ellipsized in its one row
      await withCard(browser, 390, { model: "gpt-5.6", status: "idle", mic: true }, async (page) => {
        await draft(page, false);
        const before = await drawn(page, "full", "a resting pane, a short label");
        await upload(page);
        const row = await drawn(page, "full", "a resting pane, a short label and an upload");
        assert.ok(row.hintAlone && !row.hint!.clipped && row.status === before.status, JSON.stringify(row));
        assert.ok(Math.abs(row.model!.top - row.effort!.top) < 0.5, `the name and the level share a line: ${JSON.stringify(row)}`);
      });
      await withCard(browser, 390, { model: LONG_MODEL, status: "idle", mic: true }, async (page) => {
        await draft(page, false);
        const before = await drawn(page, "no-effort", "a resting pane, a long name");
        await upload(page);
        const row = await drawn(page, "no-effort", "a resting pane, a long name and an upload");
        assert.ok(row.hintAlone && !row.hint!.clipped && row.status === before.status, JSON.stringify(row));
        assert.ok(row.model!.clipped && row.model!.bottom <= row.hint!.top + 0.5 && row.ring!.bottom <= row.hint!.top + 0.5, `the name is ellipsized beside the ring, over the sentence: ${JSON.stringify(row)}`);
      });
      // nothing but the sentence is drawn (no ring, the label out): no empty line is kept over it
      await withCard(browser, 390, { model: "gpt-5.6-sol-max", mic: true, ring: false }, async (page) => {
        await draft(page, true);
        const before = await drawn(page, "out", "no ring, the label out");
        await upload(page);
        const row = await drawn(page, "out", "no ring, the label out and an upload");
        assert.ok(row.hintAlone && !row.hint!.clipped && row.status === before.status, JSON.stringify(row));
        const centre = await page.evaluate(() => {
          const hint = document.querySelector(".composer-status-hint")!.getBoundingClientRect();
          const queue = document.querySelector(".composer-queue-button")!.getBoundingClientRect();
          return Math.abs((hint.top + hint.bottom) / 2 - (queue.top + queue.bottom) / 2);
        });
        assert.ok(centre <= 2, `the sentence alone sits on the controls' centre line: ${centre}px off`);
      });
      console.log("PASS a resting pane keeps one row of metadata over the uploading sentence, and the sentence alone is centred");

      // a task chip, the context ring and Queue together, from a phone to a wide window, with the
      // number closed and open: nothing overlaps and the label is whole or stepped out
      for (const [width, closed, open] of [[390, "out", "out"], [800, "out", "out"], [1024, "full", "out"], [1440, "full", "full"]] as const) await withCard(browser, width, { model: LONG_MODEL }, async (page) => {
        await draft(page, true);
        const row = await drawn(page, closed, `${width}px`);
        assert.ok(row.chip && row.ring && row.queue);
        await toggleRing(page, true, open);
        await drawn(page, open, `${width}px, the context number open`);
      });
      console.log("PASS at 390, 800, 1024 and 1440px a long model id is whole or stepped out beside the chip, the ring and Queue");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
