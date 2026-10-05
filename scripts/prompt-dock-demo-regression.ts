import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";

// The prompt card's place, on the unmodified app over the demo's fixture transport: the demo's
// "web" pane has an approval open. A second, tall form (steps, reference text, descriptions, a
// custom answer) is answered by this script in the transport's place. All files and HTTP traffic
// stay in this disposable, loopback-only app; no herdr session is opened.
// PROMPT_DOCK_SHOTS=<dir> also saves a screenshot of each state there.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-prompt-dock-demo-"));
const shots = process.env.PROMPT_DOCK_SHOTS ?? null;

/** omo's form on its second question, as server/prompt.ts hands it over */
const FORM = {
  id: "demo-form", agent: "omo", kind: "question", title: "Question 2 of 3",
  question: "Which store should hold the rate-limit counters for the export button?",
  body: ["export.rateLimit:", "  window: 30s", "  max: 1", "  key: user.id + report.id", "  store: ?            # memory | redis | postgres", "  onLimit: 429 + Retry-After", "  audit: true", "  tests: reports.export.spec.ts"].join("\n"),
  options: [
    { label: "In memory", description: "Simplest; counters reset on deploy and are per instance." },
    { label: "Redis (Recommended)", description: "Shared across instances; the cluster already runs one." },
    { label: "Postgres", description: "No new dependency, one extra write per export." },
    { label: "Type your own answer", description: null },
  ],
  multi_select: false, custom_option_index: 3,
  steps: [{ label: "Scope", answered: true, current: false }, { label: "Store", answered: false, current: true }, { label: "Rollout", answered: false, current: false }],
};
/** the same form as a plan to approve: a typed pick waits for Confirm */
const PLAN = { ...FORM, id: "demo-plan", kind: "plan", title: "Ready to code?", steps: undefined };

interface Box { top: number; bottom: number; left: number; right: number }
interface Layout {
  inTranscript: boolean;
  inComposer: boolean;
  order: string[];
  card: Box;
  input: Box;
  transcript: Box;
  cardTop: boolean;
  queue: Box | null;
  cap: number;
  scrolls: boolean;
  pageScrolls: boolean;
  placeholder: string;
  badge: { text: string; width: number } | null;
  live: string | null;
  overscroll: string;
}

const layoutOf = (page: Page): Promise<Layout> => page.evaluate(() => {
  const box = (node: Element): { top: number; bottom: number; left: number; right: number } => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  };
  const card = document.querySelector<HTMLElement>(".prompt-card")!;
  const stack = document.querySelector(".terminal-stack")!;
  const queue = document.querySelector(".composer-queue");
  const badge = card.querySelector<HTMLElement>(".prompt-card-header .visually-hidden");
  const app = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-height")) || window.innerHeight;
  return {
    inTranscript: card.closest(".chat-view, [role=log]") !== null,
    inComposer: card.closest(".composer") !== null,
    // the stack's own children, in order: what stands over what
    order: [...stack.children].filter((node) => node.getBoundingClientRect().height > 0).map((node) => node.className.split(" ")[0]!),
    card: box(card),
    input: box(document.querySelector(".composer-surface")!),
    // the transcript's visible box: its scroller keeps its padding and is clipped by this one
    transcript: box(document.querySelector(".terminal-surface")!),
    cardTop: (() => { const rect = card.getBoundingClientRect(); return document.elementFromPoint(rect.left + rect.width / 2, rect.top + 4)?.closest(".prompt-card") === card; })(),
    queue: queue === null ? null : box(queue),
    cap: Math.max(app * 0.6, 240),
    scrolls: card.scrollHeight > card.clientHeight + 1,
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight || document.documentElement.scrollWidth > window.innerWidth,
    placeholder: document.querySelector<HTMLTextAreaElement>(".composer-text")!.placeholder,
    badge: badge === null ? null : { text: badge.textContent ?? "", width: badge.getBoundingClientRect().width },
    live: card.closest("[aria-live]")?.getAttribute("aria-live") ?? null,
    overscroll: getComputedStyle(card).overscrollBehaviorY,
  };
});

/** What a press at the middle of an element's visible box lands on, as a class of the card or the grip. */
const hitOf = (page: Page, selector: string, at: "middle" | "bottom" = "middle"): Promise<{ hit: string | null; visible: boolean }> => page.evaluate(([target, where]) => {
  const node = [...document.querySelectorAll(target!)].at(-1)!;
  const card = document.querySelector(".prompt-card")!.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const visible = rect.top >= card.top - 1 && rect.bottom <= card.bottom + 1;
  const x = rect.left + rect.width / 2;
  const y = where === "bottom" ? rect.bottom - 2 : rect.top + rect.height / 2;
  const found = document.elementFromPoint(x, y);
  return { hit: found?.closest(".composer-resize") ? "composer-resize" : found?.closest(target!) === node ? "self" : found === null ? null : (found as HTMLElement).className || found.tagName, visible };
}, [selector, at] as const);

/** Scrolls the card (never the page) until the element is in its box, as a finger or a wheel would. */
const reach = async (page: Page, selector: string): Promise<{ hit: string | null; visible: boolean }> => {
  await page.evaluate((target) => {
    const card = document.querySelector<HTMLElement>(".prompt-card")!;
    const node = [...document.querySelectorAll<HTMLElement>(target)].at(-1)!;
    const sticky = card.querySelector<HTMLElement>(".prompt-card-confirm");
    // clear of what stays pinned on the card's fold: the confirm row and the fade under it
    const pinned = (sticky === null || sticky === node ? 0 : sticky.offsetHeight + 12) + 12;
    const over = node.getBoundingClientRect().bottom - (card.getBoundingClientRect().bottom - pinned);
    if (over > 0) card.scrollTop += over;
    const under = card.getBoundingClientRect().top - node.getBoundingClientRect().top;
    if (under > 0) card.scrollTop -= under;
  }, selector);
  return hitOf(page, selector);
};

const setPrompt = (page: Page, prompt: unknown): Promise<void> => page.evaluate((next) => { (window as unknown as { formPrompt: unknown }).formPrompt = next; }, prompt);
const answersOf = (page: Page): Promise<Record<string, unknown>[]> => page.evaluate(() => (window as unknown as { formAnswers: Record<string, unknown>[] }).formAnswers);

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
  // The demo has one approval. While window.formPrompt is set, the prompt read answers with it
  // and an answer to it is kept in window.formAnswers; everything else is the demo's.
  const form = `<script>(() => {
    const demo = window.fetch;
    window.formPrompt = null;
    window.formAnswers = [];
    window.formDelay = 0;
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (window.formPrompt !== null && url.pathname === "/api/pane/prompt") return json({ prompt: window.formPrompt, suggestion: null });
      if (window.formPrompt !== null && url.pathname === "/api/pane/prompt/answer") {
        const answer = JSON.parse(init.body);
        if (answer.prompt_id !== window.formPrompt.id) return json({ error: { code: "prompt_changed", message: "the screen no longer shows that prompt" } }, 409);
        window.formAnswers.push(answer);
        window.formPrompt = null;
        // window.formDelay: the answer takes that long to come back, as send_keys and the re-read do
        return new Promise((done) => setTimeout(done, window.formDelay || 0)).then(() => json({ ok: true }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${form}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`;
  if (shots !== null) mkdirSync(shots, { recursive: true });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      interface Opened { page: Page; errors: string[]; shot: (name: string) => Promise<void>; close: () => Promise<void> }
      const open = async ({ width, height, touch = false, held = [], prompt = null, theme = "dark", language = "en", settings = {} }: { width: number; height: number; touch?: boolean; held?: string[]; prompt?: unknown; theme?: string; language?: string; settings?: Record<string, unknown> }): Promise<Opened> => {
        const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", hasTouch: touch, isMobile: touch });
        await context.addInitScript(([owner, messages, settings]) => {
          localStorage.setItem("herdr-web-ui:settings", settings!);
          if (messages !== "") localStorage.setItem(`herdr-web-ui:queue:${owner}`, messages!);
        }, [panes.web, held.length === 0 ? "" : JSON.stringify({ version: 1, messages: held.map((text, at) => ({ id: `m${at}`, text })) }), JSON.stringify({ language, theme, ...settings })] as const);
        // a soft keyboard the script can raise: lib/viewport.ts reads navigator.virtualKeyboard
        if (touch) await context.addInitScript(() => {
          const keyboard = Object.assign(new EventTarget(), { height: 0 });
          Object.defineProperty(keyboard, "boundingRect", { get: () => new DOMRect(0, 0, 390, keyboard.height) });
          Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: keyboard });
        });
        if (prompt !== null) await context.addInitScript((next) => { window.addEventListener("DOMContentLoaded", () => { (window as unknown as { formPrompt: unknown }).formPrompt = next; }); }, prompt);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        if (prompt !== null) await setPrompt(page, prompt);
        await page.locator(".prompt-card").waitFor();
        if (prompt !== null) await page.locator(".prompt-card").getByText((prompt as { question: string }).question).waitFor();
        return { page, errors, close: () => context.close(), shot: async (name) => { if (shots !== null) await page.screenshot({ path: join(shots, `${name}.png`) }); } };
      };

      /** the card's place in the stack, the same at every size */
      const placed = (layout: Layout, label: string): void => {
        assert.equal(layout.inTranscript, false, `${label}: the card is outside the transcript`);
        assert.equal(layout.inComposer, false, `${label}: the card is not inside the message composer's group`);
        assert.equal(layout.live, "polite", `${label}: a prompt that arrives is announced`);
        assert.equal(layout.overscroll, "contain", `${label}: a drag past the card's top is not handed to the page (pull-to-refresh)`);
        const at = layout.order.indexOf("prompt-dock");
        assert.equal(layout.order[at + 1], "composer", `${label}: the input card is the next thing under the card (${layout.order.join(" > ")})`);
        assert.ok(layout.order.indexOf("terminal-surface") < at, `${label}: the transcript is over the card`);
        assert.ok(layout.card.bottom <= layout.input.top, `${label}: the card ends over the input card`);
        assert.ok(layout.input.top - layout.card.bottom <= 24, `${label}: nothing stands between them (${layout.input.top - layout.card.bottom}px)`);
        assert.ok(Math.abs(layout.card.left - layout.input.left) <= 1 && Math.abs(layout.card.right - layout.input.right) <= 1, `${label}: one column (${layout.card.left}–${layout.card.right} over ${layout.input.left}–${layout.input.right})`);
        assert.ok(layout.transcript.bottom <= layout.card.top + 1, `${label}: the transcript ends over the card`);
        assert.equal(layout.cardTop, true, `${label}: nothing of the transcript is painted over the card`);
        assert.ok(layout.card.bottom - layout.card.top <= layout.cap + 1, `${label}: the card keeps to its height (${layout.card.bottom - layout.card.top} of ${layout.cap})`);
        assert.equal(layout.pageScrolls, false, `${label}: the page itself does not scroll`);
        assert.deepEqual(layout.badge?.text, "input needed", `${label}: the badge is still read`);
        assert.ok(layout.badge!.width <= 1, `${label}: the badge is not drawn`);
      };

      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844, touch: true }]) {
        for (const theme of ["dark", "light"]) {
          const { page, errors, shot, close } = await open({ ...size, theme });
          try {
            const layout = await layoutOf(page);
            placed(layout, `${size.width}x${size.height} ${theme}`);
            assert.equal(layout.scrolls, false, "a three-option approval is whole");
            assert.equal(layout.placeholder, "Type 1–3 to choose…");
            assert.equal(await page.evaluate(() => { const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!; const probe = document.createElement("span"); probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(box).font}`; probe.textContent = box.placeholder; document.body.append(probe); const fits = probe.getBoundingClientRect().width <= box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight); probe.remove(); return fits; }), true, "the placeholder is whole on one line");
            // the command is the card's mono box; the title, the card's one red, is its heading
            assert.equal(await page.locator(".prompt-card-body").textContent(), "git push origin feat/export-guard");
            assert.equal(await page.locator(".prompt-card-question").count(), 0, "a heading that is the question is said once");
            // every option weighs the same: none is filled or outlined as the default
            const weights = await page.locator(".prompt-card-option").evaluateAll((nodes) => nodes.map((node) => { const style = getComputedStyle(node); return `${style.backgroundColor}|${style.borderTopColor}|${style.fontWeight}`; }));
            assert.equal(new Set(weights).size, 1, `no option is emphasised: ${weights.join(" / ")}`);
            // the keycap draws the number alone; the option is still named as the agent's menu shows it
            assert.deepEqual(await page.locator(".prompt-card-number > [aria-hidden]").allTextContents(), ["1", "2", "3"]);
            for (const name of ["1. Yes", "2. Yes, and don't ask again for git push", "3. No, and tell Codex what to do differently"]) assert.equal(await page.locator(".prompt-card").getByRole("button", { name, exact: true }).count(), 1, name);
            // the grip's hit strip is the composer's own: the card's last row is pressed, not the grip
            assert.deepEqual(await hitOf(page, ".prompt-card-option", "bottom"), { hit: "self", visible: true });
            const grip = await page.evaluate(() => { const strip = document.querySelector(".composer-resize")!.getBoundingClientRect(); return { top: strip.top, card: document.querySelector(".prompt-card")!.getBoundingClientRect().bottom }; });
            assert.ok(grip.top >= grip.card - 0.5, `the grip's strip starts under the card (${grip.top} against ${grip.card})`);
            // the open work block says who waits: the sidebar's words, a still red dot
            const head = await page.locator(".work-block.is-live .work-block-title").evaluate((node) => ({ text: node.textContent, waiting: node.closest(".work-block")!.classList.contains("is-waiting"), dot: getComputedStyle(node, "::before").animationName }));
            assert.deepEqual(head, { text: "Needs you", waiting: true, dot: "none" });
            assert.deepEqual(errors, []);
            await shot(`approval-${size.width}-${theme}`);
          } finally { await close(); }
        }
      }
      console.log("PASS the approval card sits outside the transcript, directly over the input card on its column, at 1440 and 390, dark and light");

      {
        // nothing is answered without a press: Enter in an empty message box picks no option
        const { page, errors, close } = await open({ width: 1440, height: 900 });
        try {
          const box = page.locator(".composer-text");
          await box.focus();
          await box.press("Enter");
          await page.waitForTimeout(300);
          assert.equal(await page.locator(".prompt-card").count(), 1, "Enter in an empty box answers nothing");
          assert.equal(await page.locator(".prompt-card-confirm").count(), 0);
          // a typed number picks, and waits for Confirm in the card
          await box.fill("2");
          await box.press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          assert.equal(await page.locator(".prompt-card-option.is-typed .prompt-card-option-label").textContent(), "Yes, and don't ask again for git push");
          assert.equal(await page.locator(".prompt-card").count(), 1, "a typed pick is not sent before Confirm");
          // the typed pick keeps its accent: the one row that is outlined and tinted
          // (the outline fades in: read it once the transition is over)
          await page.waitForFunction(() => document.querySelector(".prompt-card-option.is-typed")!.getAnimations().length === 0);
          const typed = await page.evaluate(() => { const style = (selector: string): CSSStyleDeclaration => getComputedStyle(document.querySelector(selector)!); return { row: style(".prompt-card-option.is-typed").borderTopColor, fill: style(".prompt-card-option.is-typed").backgroundColor, confirm: style(".prompt-card-confirm").borderTopColor, other: style(".prompt-card-option:not(.is-typed)").backgroundColor }; });
          assert.equal(typed.row, typed.confirm, "the typed option is outlined in the accent");
          assert.notEqual(typed.fill, typed.other, "and tinted");
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Cancel" }).click();
          assert.equal(await page.locator(".prompt-card-confirm").count(), 0);
          // keyboard order: the card's options come before the message box
          await page.getByRole("button", { name: "1. Yes", exact: true }).focus();
          for (let step = 0; step < 3; step += 1) await page.keyboard.press("Tab");
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".composer") !== null), true, "Tab leaves the card into the composer");
          // a press on an option answers, and the keyboard's focus goes on to the message box
          await page.getByRole("button", { name: "1. Yes", exact: true }).click();
          await page.locator(".prompt-card").waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text");
          assert.equal(await page.locator(".prompt-dock").evaluate((node) => node.getBoundingClientRect().height), 0, "without a card its place takes no room");
          // but it is still rendered: a live region that appears together with its card is not read
          const region = await page.locator(".prompt-dock").evaluate((node) => ({ live: node.getAttribute("aria-live"), display: getComputedStyle(node).display, hidden: getComputedStyle(node).visibility, empty: node.childElementCount === 0, gap: node.getBoundingClientRect().bottom - document.querySelector(".composer")!.getBoundingClientRect().top }));
          assert.deepEqual(region, { live: "polite", display: "flex", hidden: "visible", empty: true, gap: 0 }, "the empty dock is an exposed live region, waiting for the next card, and adds no space");
          // the next prompt is an addition inside that region
          await setPrompt(page, FORM);
          await page.locator(".prompt-dock > .prompt-card").getByText(FORM.question).waitFor();
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS an empty Enter answers nothing, a typed pick waits for Confirm, a press answers and hands the focus to the message box");
      }

      {
        // held messages fold to their caption over the card: caption, card, input card
        const { page, errors, shot, close } = await open({ width: 1440, height: 900, held: ["Also cover a replay after the key has expired."] });
        try {
          await page.locator(".composer-queue-toggle").waitFor();
          const layout = await layoutOf(page);
          placed(layout, "held");
          assert.deepEqual(layout.order.slice(-3), ["composer-queue", "prompt-dock", "composer"]);
          assert.ok(layout.queue!.bottom <= layout.card.top, "the held caption is over the card");
          assert.ok(Math.abs(layout.queue!.left - layout.card.left) <= 1 && Math.abs(layout.queue!.right - layout.card.right) <= 1, "the caption and the card share the column");
          await shot("held-1440");
          // opened, the rows' buttons end over the card and are pressed, not the card
          await page.locator(".composer-queue-toggle").click();
          const opened = await layoutOf(page);
          placed(opened, "held rows opened");
          assert.ok(opened.queue!.bottom <= opened.card.top);
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS a held caption sits over the card, on its column");
      }

      // the tall form: steps, reference text, descriptions, a custom answer
      // ... and again at the largest chat font size, which the card follows
      for (const size of [{ width: 1440, height: 900 }, { width: 800, height: 600 }, { width: 390, height: 844, touch: true }, { width: 390, height: 500, touch: true }, { width: 1440, height: 900, font: 24 }, { width: 390, height: 844, touch: true, font: 24 }, { width: 390, height: 500, touch: true, font: 24 }]) {
        const label = `${size.width}x${size.height}${size.font ? ` at ${size.font}px` : ""}`;
        const { page, errors, shot, close } = await open({ ...size, prompt: PLAN, settings: size.font ? { chatFontSize: size.font } : {} });
        try {
          const layout = await layoutOf(page);
          placed(layout, label);
          assert.equal(layout.placeholder, "Type 1–3 or your own reply…");
          // a desktop window keeps some of the transcript in sight over the tallest card: two lines
          // of it at 800x600, where the card has its full 60%
          if (size.width >= 800) assert.ok(layout.transcript.bottom - layout.transcript.top >= 48, `${label}: the transcript keeps ${layout.transcript.bottom - layout.transcript.top}px`);
          // what the user answers with keeps its height: only the reference text gives way
          const parts = await page.evaluate(() => Object.fromEntries([".prompt-card-header", ".prompt-card-question", ".prompt-card-options", ".prompt-card-custom"].map((selector) => { const node = document.querySelector<HTMLElement>(selector)!; return [selector, node.offsetHeight >= node.scrollHeight]; })));
          assert.deepEqual(parts, { ".prompt-card-header": true, ".prompt-card-question": true, ".prompt-card-options": true, ".prompt-card-custom": true }, `${label}: nothing to answer with is squeezed`);
          const body = await page.locator(".prompt-card-body").evaluate((node) => ({ height: node.clientHeight, line: parseFloat(getComputedStyle(node).lineHeight) }));
          assert.ok(body.height >= 2 * body.line && body.height <= 6 * body.line + 20, `${label}: the reference text shows two to six lines (${body.height / body.line})`);
          // a typed pick: its Confirm row is in sight at once, whatever the card's scroll
          await page.locator(".composer-text").fill("2");
          await page.locator(".composer-text").press("Enter");
          await page.locator(".prompt-card-confirm").waitFor();
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn-primary"), { hit: "self", visible: true }, `${label}: Confirm is in sight and pressable`);
          await page.waitForFunction(() => document.querySelector(".prompt-card-option.is-typed")!.getAnimations().length === 0);
          await shot(`form-${label}`);
          // every option and the custom answer are reached by scrolling the card alone
          for (let option = 0; option < 3; option += 1) {
            const reached = await page.evaluate((at) => { document.querySelectorAll(".prompt-card-option")[at]!.setAttribute("data-reach", ""); return true; }, option);
            assert.ok(reached);
            assert.deepEqual(await reach(page, ".prompt-card-option[data-reach]"), { hit: "self", visible: true }, `${label}: option ${option + 1} is reachable`);
            await page.evaluate(() => document.querySelector("[data-reach]")!.removeAttribute("data-reach"));
          }
          assert.deepEqual(await reach(page, ".prompt-card-custom .input"), { hit: "self", visible: true }, `${label}: the custom answer is reachable`);
          assert.deepEqual(await reach(page, ".prompt-card-custom .btn"), { hit: "self", visible: true }, `${label}: its Send is reachable`);
          assert.deepEqual(await hitOf(page, ".prompt-card-confirm .btn-primary"), { hit: "self", visible: true }, `${label}: Confirm stays in sight while the card is scrolled`);
          assert.equal((await layoutOf(page)).pageScrolls, false, `${label}: only the card scrolled`);
          // Confirm sends the typed pick, once, through the answer endpoint
          await page.locator(".prompt-card-confirm").getByRole("button", { name: "Confirm" }).click();
          await page.locator(".prompt-card").getByText(PLAN.question).waitFor({ state: "detached" });
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-plan", option_index: 1 }]);
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log(`PASS at ${label} the tall form's options, custom answer and Confirm are all reachable, and Confirm sends the pick once`);
      }

      {
        // omo's form: step chips, a recommended tag kept as the agent marked it, a custom answer sent as text
        const { page, errors, shot, close } = await open({ width: 390, height: 500, touch: true, prompt: FORM, held: ["Then bump the changelog."] });
        try {
          await page.locator(".composer-queue-toggle").waitFor();
          const layout = await layoutOf(page);
          placed(layout, "form + held at 390x500");
          assert.ok(layout.queue!.bottom <= layout.card.top, "the held caption is over the card on a short phone too");
          assert.equal(await page.locator(".prompt-card-step").count(), 3);
          assert.equal(await page.locator(".prompt-card-tag").textContent(), "Recommended");
          assert.equal(layout.scrolls, true, "the form is taller than a phone with its keyboard up: the card scrolls");
          await shot("form-held-390x500");
          assert.deepEqual(await reach(page, ".prompt-card-custom .input"), { hit: "self", visible: true });
          // the card's last row is pressed at its bottom edge, where the grip's strip would have been
          assert.deepEqual(await reach(page, ".prompt-card-custom .btn"), { hit: "self", visible: true });
          assert.deepEqual(await hitOf(page, ".prompt-card-custom .btn", "bottom"), { hit: "self", visible: true });
          await page.locator(".prompt-card-custom .input").fill("sqlite, one file");
          await page.locator(".prompt-card-custom").getByRole("button", { name: "Send" }).click();
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", custom_text: "sqlite, one file" }]);
          // a touch screen: the answer does not raise the keyboard by moving focus to the message box
          assert.notEqual(await page.evaluate(() => document.activeElement?.className.split(" ")[0]), "composer-text");
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS omo's form under a held caption on a short phone: steps, the agent's own Recommended tag, a custom answer sent as text");
      }

      {
        // Settings → Chat font size and Chat font reach the card, as they did inside the transcript
        const { page, errors, close } = await open({ width: 1440, height: 900, settings: { chatFontSize: 22, chatFontFamily: "Georgia" } });
        try {
          const type = await page.evaluate(() => {
            const of = (selector: string): { size: number; family: string } => { const style = getComputedStyle(document.querySelector(selector)!); return { size: parseFloat(style.fontSize), family: style.fontFamily }; };
            return { prose: of(".chat-transcript"), title: of(".prompt-card-header h2"), option: of(".prompt-card-option-label"), body: of(".prompt-card-body"), keycap: of(".prompt-card-number"), scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--chat-scale")) };
          });
          assert.equal(type.prose.size, 22);
          assert.ok(type.scale > 1.5, `the chat is scaled (${type.scale})`);
          // each part keeps its own step of the scale: 13px, 12px and 11px times the chat's
          assert.ok(Math.abs(type.title.size - 13 * type.scale) < 0.1 && Math.abs(type.option.size - 13 * type.scale) < 0.1, `the title and the options grow with the chat (${type.title.size}px, ${type.option.size}px)`);
          assert.ok(Math.abs(type.body.size - 12 * type.scale) < 0.1, `so does the reference text (${type.body.size}px)`);
          assert.ok(Math.abs(type.keycap.size - 11 * type.scale) < 0.1, `and the keycap (${type.keycap.size}px)`);
          assert.match(type.title.family, /Georgia/, "the card's prose is in the chat's font");
          assert.match(type.option.family, /Georgia/);
          assert.doesNotMatch(type.body.family, /Georgia/, "the reference text stays mono");
          assert.doesNotMatch(type.keycap.family, /Georgia/);
          placed(await layoutOf(page), "chat font 22px");
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS the card follows the chat's font size and font; its reference text and keycaps stay mono");
      }

      {
        // A phone with its keyboard up: the card stands where the transcript was, so a tap on its
        // text and a drag down it put the keyboard away, as on the transcript. Chromium blurs a
        // field on any real tap outside it and iOS does not, so these are events without a
        // browser default: only the card's own handler can blur the box.
        const { page, errors, close } = await open({ width: 390, height: 500, touch: true, prompt: FORM });
        try {
          const box = page.locator(".composer-text");
          const raise = async (): Promise<void> => {
            await box.focus();
            await page.evaluate(() => { const keyboard = (navigator as unknown as { virtualKeyboard: EventTarget & { height: number } }).virtualKeyboard; keyboard.height = 300; keyboard.dispatchEvent(new Event("geometrychange")); });
            await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && document.activeElement?.classList.contains("composer-text") === true);
          };
          const typing = (): Promise<boolean> => page.evaluate(() => document.activeElement?.classList.contains("composer-text") === true);
          const drag = (selector: string): Promise<void> => page.evaluate((target) => {
            const node = document.querySelector(target)!;
            const rect = node.getBoundingClientRect();
            const at = (y: number): TouchEventInit => ({ bubbles: true, touches: [new Touch({ identifier: 1, target: node, clientX: rect.left + 40, clientY: y })] });
            node.dispatchEvent(new TouchEvent("touchstart", at(rect.top + 4)));
            node.dispatchEvent(new TouchEvent("touchmove", at(rect.top + 64)));
          }, selector);
          const click = (selector: string): Promise<void> => page.evaluate((target) => { document.querySelector(target)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }, selector);

          await raise();
          await click(".prompt-card-question");
          assert.equal(await typing(), false, "a tap on the card's question puts the keyboard away");
          await raise();
          await drag(".prompt-card-question");
          assert.equal(await typing(), false, "a drag down the card at its top puts the keyboard away");
          // a scrolled card: the drag down is the way back to its top, and the keyboard stays
          await raise();
          assert.ok(await page.locator(".prompt-card").evaluate((node) => { node.scrollTop = 40; return node.scrollTop; }) > 0);
          await drag(".prompt-card-options");
          assert.equal(await typing(), true, "a drag down a scrolled card keeps the keyboard");
          await page.locator(".prompt-card").evaluate((node) => { node.scrollTop = 0; });
          // the card's own field keeps its keyboard, and a press on a row is not a request to read
          await drag(".prompt-card-custom .input");
          assert.equal(await typing(), true, "a drag on the card's field keeps the keyboard");
          await click(".prompt-card-option-label");
          assert.equal(await typing(), true, "an option is a button: its tap is not a request to read");
          assert.deepEqual(await answersOf(page), [{ pane_id: panes.web, prompt_id: "demo-form", option_index: 0 }], "and it still answers");
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS with a phone's keyboard up, a tap on the card's text or a drag down it at its top puts the keyboard away; an option still answers");
      }

      {
        // An answer that takes a moment: focus goes on to the message box only if nothing else
        // took it meanwhile
        const { page, errors, close } = await open({ width: 1440, height: 900, prompt: FORM });
        try {
          await page.evaluate(() => { (window as unknown as { formDelay: number }).formDelay = 600; });
          await page.locator(".prompt-card").getByRole("button", { name: /^1\. In memory/ }).click();
          await page.locator(".prompt-card[aria-busy=true]").waitFor();
          // the user goes on to something else while the answer is on its way
          const elsewhere = page.locator(".app-header button:not([disabled]):visible").first();
          await elsewhere.focus();
          assert.equal(await elsewhere.evaluate((node) => document.activeElement === node), true);
          assert.equal(await page.locator(".prompt-card").getAttribute("aria-busy"), "true", "the answer is still on its way");
          await page.locator(".prompt-card").getByText(FORM.question).waitFor({ state: "detached" });
          assert.equal((await answersOf(page)).length, 1);
          assert.equal(await elsewhere.evaluate((node) => document.activeElement === node), true, "focus stays where the user put it while the answer was on its way");
          assert.deepEqual(errors, []);
        } finally { await close(); }
        console.log("PASS an answer that comes back late does not pull the focus from where the user went");
      }

      for (const language of ["ko", "ja", "zh"]) {
        // the translated placeholders fit the phone's message box on one line too
        const { page, close } = await open({ width: 390, height: 844, touch: true, prompt: PLAN, language });
        try {
          const fit = await page.evaluate(() => { const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!; const probe = document.createElement("span"); probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(box).font}`; probe.textContent = box.placeholder; document.body.append(probe); const width = probe.getBoundingClientRect().width; probe.remove(); return { text: box.placeholder, width, room: box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight) }; });
          assert.ok(fit.width <= fit.room, `${language}: "${fit.text}" is ${fit.width}px in ${fit.room}px`);
        } finally { await close(); }
      }
      console.log("PASS the placeholder with a custom answer fits a 390px message box in ko, ja and zh");
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
