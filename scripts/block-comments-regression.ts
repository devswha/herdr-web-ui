/** Block comments on an agent's reply, desktop and phone, with a real Codex transcript and an owned herdr pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const ANSWER = [
  "Intro paragraph about the state.",
  "",
  "1. Run the migration",
  "2. Restart the server",
  "   - check the logs",
  "",
  "See [docs](https://example.com).",
  "",
  "A longer paragraph that runs across several lines on a phone, so its first line reaches the right edge where the comment button sits.",
  "",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-block-comments-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc12";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-10-04T00-00-00-${thread}.jsonl`);
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { timestamp: "2026-10-04T10:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the plan." }] } },
  { timestamp: "2026-10-04T10:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: ANSWER }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the plan.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

/** The computed opacity of a "+": 0 while it is hidden. */
const opacity = (add: Locator): Promise<number> => add.evaluate((node) => Number(getComputedStyle(node).opacity));
/** Waits up to 2 s, frame by frame, for a "+" to finish fading in. */
async function shown(add: Locator): Promise<void> {
  await add.evaluate((node) => new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const check = (): void => {
      if (getComputedStyle(node).opacity === "1") resolve();
      else if (Date.now() > deadline) reject(new Error("the + did not show"));
      else requestAnimationFrame(check);
    };
    check();
  }));
}
/** The block's own "+", not one of a nested block inside it. */
const ownAdd = (block: Locator): Locator => block.locator(":scope > .block-comment-add");

/** Comments `text` on `block` the way a desktop reader does: hover, "+", type, Save. */
async function comment(page: Page, block: Locator, text: string): Promise<void> {
  await block.hover();
  await shown(ownAdd(block));
  await ownAdd(block).click();
  const editor = page.locator(".comment-editor");
  await editor.waitFor();
  await editor.getByRole("textbox", { name: "Comment" }).fill(text);
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await editor.waitFor({ state: "hidden" });
}

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-block-comments" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  const origin = `http://127.0.0.1:${server.port}`;
  const url = `${origin}/?pane=${encodeURIComponent(pane)}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const errors: string[] = [];
  /** Opens the pane's chat in a new context, with `comments` stored for it beforehand, and records every submitted text. */
  const open = async (options: Parameters<NonNullable<typeof browser>["newContext"]>[0], comments?: unknown): Promise<{ page: Page; sent: string[] }> => {
    const context = await browser!.newContext(options);
    await context.route("https://example.com/**", (route) => route.abort());
    const page = await context.newPage();
    await page.addInitScript(({ id, stored }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
      if (stored !== undefined) localStorage.setItem(`herdr-web-ui:block-comments:${id}`, JSON.stringify(stored));
    }, { id: pane, stored: comments });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type === "submit") sent.push(frame.text);
      } catch { /* not JSON */ }
    }));
    await page.goto(url);
    await page.locator(".conn-live").waitFor();
    await page.locator("p.is-commentable", { hasText: "Intro paragraph about the state." }).waitFor();
    return { page, sent };
  };

  // ── desktop ──
  {
    const { page, sent } = await open({ viewport: { width: 1280, height: 800 } });
    const intro = page.locator("p.is-commentable", { hasText: "Intro paragraph about the state." });
    const nested = page.locator("li.is-commentable li.is-commentable", { hasText: "check the logs" });
    const code = page.locator(".markdown-block.is-commentable", { has: page.locator(".markdown-code") });
    assert.equal(await page.locator(".chat-turn-user .is-commentable").count(), 0, "a user message is not commentable");

    await intro.hover();
    await shown(ownAdd(intro));
    // flush with the top of the tinted block (the tint reaches 4px past the text), not below it
    const introBox = (await intro.boundingBox())!;
    const plus = (await ownAdd(intro).boundingBox())!;
    assert.ok(Math.abs(plus.y - (introBox.y - 4)) <= 1, `the + is flush with the tint's top (off by ${plus.y - (introBox.y - 4)}px)`);
    await ownAdd(intro).click();
    const editor = page.locator(".comment-editor");
    await editor.waitFor();
    assert.match(await editor.locator(".comment-editor-block").innerText(), /Intro paragraph about the state\./);
    assert.equal(await editor.locator(".block-comment-add").count(), 0, "no + inside the editor");
    // the field starts one line high, grows with what is typed, and scrolls past its cap
    const field = editor.getByRole("textbox", { name: "Comment" });
    assert.equal(await field.getAttribute("placeholder"), "Write a comment…");
    const lineHeight = await field.evaluate((node) => parseFloat(getComputedStyle(node).lineHeight));
    const empty = (await field.boundingBox())!.height;
    assert.ok(empty < 2 * lineHeight, `the empty field is one line high (${empty}px)`);
    await field.fill("one\ntwo\nthree");
    const three = (await field.boundingBox())!.height;
    assert.ok(three >= empty + 2 * lineHeight - 1, `three lines grow the field (${empty} → ${three}px)`);
    await field.fill(Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n"));
    const capped = await field.evaluate((node) => ({ height: node.getBoundingClientRect().height, scrolls: node.scrollHeight > node.clientHeight }));
    assert.ok(capped.height <= 4 * lineHeight + 20 && capped.scrolls, `twenty lines stop at four and scroll (${capped.height}px)`);
    await field.fill("Explain why");
    assert.ok((await field.boundingBox())!.height < 2 * lineHeight, "the field shrinks back with its text");
    console.log("PASS desktop: the comment field grows with its text, up to a cap");
    await editor.getByRole("textbox", { name: "Comment" }).fill("Explain why");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await page.locator("p.is-commented", { hasText: "Intro paragraph" }).waitFor();
    assert.equal(await page.locator(".block-comment-row").first().innerText(), "Explain why");
    assert.equal(await page.locator(".composer-comment-open").count(), 1);
    console.log("PASS desktop: hover shows +, the modal saves a comment, the block is marked and a pill appears");

    // the parent item's + stays hidden while the nested one is under the pointer
    await nested.hover();
    await shown(ownAdd(nested));
    const parent = page.locator("li.is-commentable", { hasText: "Restart the server" }).first();
    assert.equal(await opacity(ownAdd(parent)), 0, "only the innermost hovered block shows its +");
    if (evidence) await page.screenshot({ path: join(evidence, "block-comments-desktop-hover.png"), clip: { x: 320, y: 130, width: 900, height: 200 } });
    await comment(page, nested, "Also the exit code");
    await comment(page, code, "Use let");
    assert.equal(await page.locator(".is-commented").count(), 3);
    if (evidence) await page.screenshot({ path: join(evidence, "block-comments-desktop.png") });

    // from the last line of a long block, through the gutter, up to its "+": it stays to be clicked
    const long = page.locator("p.is-commentable", { hasText: "A longer paragraph" });
    const box = (await long.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height - 4);
    const add = (await ownAdd(long).boundingBox())!;
    await page.mouse.move(add.x + add.width / 2, box.y + box.height - 4, { steps: 8 });
    await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2, { steps: 8 });
    assert.ok(add.x + add.width <= box.x - 4, "the + sits in the gutter, clear of the text");
    await ownAdd(long).click();
    await editor.waitFor();
    assert.match(await editor.locator(".comment-editor-block").innerText(), /A longer paragraph/);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    console.log("PASS desktop: the + is reachable from any line of its block, through the gutter");

    // a quick sweep over the reply shows no trail of "+": only a block the pointer rests on gets one
    const reply = (await page.locator(".chat-turn-agent").boundingBox())!;
    await page.mouse.move(reply.x + 60, reply.y + 2);
    await page.waitForTimeout(600);
    await page.mouse.move(reply.x + 60, reply.y + reply.height - 60, { steps: 12 });
    const trail = await page.evaluate(() => [...document.querySelectorAll(".chat-view .block-comment-add")].filter((node) => Number(getComputedStyle(node).opacity) > 0).length);
    assert.ok(trail <= 1, `a quick sweep leaves ${trail} "+" showing`);
    console.log("PASS desktop: a quick sweep over the reply shows no trail of +");

    await page.locator(".composer-comment-open", { hasText: "Intro paragraph" }).click();
    await editor.waitFor();
    await editor.getByRole("textbox", { name: "Comment" }).fill("Explain why, briefly");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(await page.locator("p.is-commented + .block-comment-row").innerText(), "Explain why, briefly");

    await page.locator(".markdown-block.is-commented + .block-comment-row").click();
    // Delete stays a danger button under the pointer, not the neutral grey of the others
    const del = editor.getByRole("button", { name: "Delete", exact: true });
    const rest = await del.evaluate((node) => getComputedStyle(node).borderColor);
    await del.hover();
    await page.waitForTimeout(250);
    const hovered = await del.evaluate((node) => getComputedStyle(node).borderColor);
    assert.equal(hovered, rest, "Delete keeps its danger border on hover");
    await del.click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".composer-comment-open").count(), 2);
    console.log("PASS desktop: edit from a pill, delete from the chat row");

    // the keyboard reaches a block's "+" by Tab, though nothing in the block itself takes focus:
    // from the last control of the user's message, the next stop is the reply's first "+"
    await page.mouse.move(5, 5);
    await page.locator(".chat-turn-user button").last().focus();
    await page.keyboard.press("Tab");
    assert.equal(await ownAdd(intro).evaluate((node) => node === document.activeElement), true, "Tab from the user's message lands on the first block's +");
    await shown(ownAdd(intro));
    await page.keyboard.press("Enter");
    await editor.waitFor();
    await page.keyboard.press("Escape");
    await editor.waitFor({ state: "hidden" });
    assert.equal(await ownAdd(intro).evaluate((node) => node === document.activeElement), true, "closing the editor hands the focus back to the +");
    console.log("PASS desktop: Tab reaches a block's +, and the focus comes back to it");

    // removing a pill hands the focus to its neighbour, not to the page
    await comment(page, long, "Temporary");
    await page.locator(".composer-comment", { hasText: "A longer paragraph" }).getByRole("button", { name: "Remove comment" }).click();
    await page.locator(".composer-comment", { hasText: "A longer paragraph" }).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".composer-comment")?.textContent ?? document.activeElement?.tagName), "check the logs", "the focus moves to the pill beside the removed one");
    console.log("PASS desktop: removing a pill keeps the focus in the pill row");

    // the agent starts again while a comment is being written: the editor and the draft stay, and
    // the code block is not rebuilt as the reply turns live and final again
    await page.locator(".markdown-code").evaluate((node) => { (node as HTMLElement).dataset.kept = "yes"; });
    await intro.hover();
    await shown(ownAdd(intro));
    await ownAdd(intro).click();
    await editor.waitFor();
    await editor.getByRole("textbox", { name: "Comment" }).fill("half a thought");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "working", agent_session_path: transcript });
    await page.locator(".chat-turn-agent .is-commentable").first().waitFor({ state: "detached" });
    assert.equal(await editor.getByRole("textbox", { name: "Comment" }).inputValue(), "half a thought", "the draft survives the reply turning live");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
    await page.locator("p.is-commentable", { hasText: "Intro paragraph" }).waitFor();
    assert.equal(await page.locator(".markdown-code").evaluate((node) => (node as HTMLElement).dataset.kept), "yes", "the code block is the same element after live and back");
    console.log("PASS desktop: a reply turning live keeps the open editor, and its code block");

    // a narrow window leaves no gutter: the + goes to the block's top right, as on a phone
    await page.setViewportSize({ width: 820, height: 800 });
    await long.hover();
    await shown(ownAdd(long));
    const narrow = (await long.boundingBox())!;
    const narrowAdd = (await ownAdd(long).boundingBox())!;
    assert.ok(narrowAdd.x > narrow.x + narrow.width / 2 && narrowAdd.x + narrowAdd.width > narrow.x + narrow.width && narrowAdd.y < narrow.y, "the + stands out past the top right corner in a narrow window");
    await page.setViewportSize({ width: 1280, height: 800 });
    console.log("PASS desktop: a narrow window puts the + at the top right");

    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.locator("p.is-commented").waitFor();
    assert.equal(await page.locator(".composer-comment-open").count(), 2);
    assert.equal(await page.locator(".is-commented").count(), 2);
    console.log("PASS desktop: comments survive a reload");

    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Thanks");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.locator(".composer-comments").waitFor({ state: "detached" });
    assert.equal(await page.locator(".is-commented").count(), 0);
    assert.ok(sent.some((text) => text.startsWith("> Intro paragraph about the state.\nExplain why, briefly\n\n> check the logs\nAlso the exit code\n\nThanks")), `sent: ${JSON.stringify(sent)}`);
    console.log("PASS desktop: send carries the comments quoted, in reading order, then clears them");
    await page.context().close();
  }

  // ── phone ──
  {
    const { page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    assert.equal(await page.evaluate(() => matchMedia("(hover: none)").matches), true, "the phone context has no hover");
    const item = page.locator("li.is-commentable", { hasText: "Run the migration" });
    await item.tap();
    await page.locator("li.is-commentable.is-selected", { hasText: "Run the migration" }).waitFor();
    await shown(ownAdd(item));
    // a badge on the block's top right corner, standing out past it, not over its words
    const itemBox = (await item.boundingBox())!;
    const badge = (await ownAdd(item).boundingBox())!;
    assert.ok(badge.y < itemBox.y && badge.x + badge.width > itemBox.x + itemBox.width, "the + stands out past the block's top right corner");
    if (evidence) await page.screenshot({ path: join(evidence, "block-comments-phone-selected.png"), clip: { x: 0, y: Math.max(0, itemBox.y - 60), width: 390, height: 160 } });
    await page.locator(".chat-turn-user .chat-bubble").tap();
    await page.locator(".is-commentable.is-selected").waitFor({ state: "detached" });
    console.log("PASS phone: a tap chooses a block and shows its +, a tap elsewhere lets it go");

    await item.tap();
    await shown(ownAdd(item));
    await ownAdd(item).tap();
    const editor = page.locator(".comment-editor");
    await editor.waitFor();
    const fits = await editor.evaluate((node) => node.getBoundingClientRect().bottom <= (window.visualViewport?.height ?? window.innerHeight) + 1);
    assert.ok(fits, "the editor sits inside the visible viewport");
    // the title is no control: a tap on it would reach the item's handler through the React tree
    await editor.locator(".modal-title").tap();
    await editor.locator(".comment-editor-block").tap();
    assert.equal(await page.locator(".is-commentable.is-selected").count(), 0, "a tap inside the editor does not choose the block under it");
    if (evidence) await page.screenshot({ path: join(evidence, "block-comments-phone-editor.png") });
    await editor.getByRole("button", { name: "Cancel", exact: true }).tap();
    await editor.waitFor({ state: "hidden" });
    console.log("PASS phone: the editor sits above the fold, and taps inside it stay inside it");

    await page.getByRole("link", { name: "docs", exact: true }).tap();
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".is-commentable.is-selected").count(), 0, "a tap on a link does not choose its paragraph");
    console.log("PASS phone: a link tap opens the link and leaves the block alone");
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // ── a stored comment whose block this version cannot draw ──
  {
    const broken = { id: "broken", anchor: "x:0:0", order: [0, 0, 0], comment: "kept", block: { type: "blockquote", blocks: [{ type: "video" }] } };
    const { page } = await open({ viewport: { width: 1280, height: 800 } }, { version: 1, comments: [broken] });
    await page.locator(".composer-comment-open").click();
    const editor = page.locator(".comment-editor");
    await editor.waitFor();
    assert.equal(await editor.getByRole("textbox", { name: "Comment" }).inputValue(), "kept");
    await page.locator(".conn-live").waitFor();
    assert.deepEqual(errors.filter((message) => !/render failed/.test(message)), []);
    console.log("PASS a block the editor cannot draw leaves the app and the comment usable");
    await page.context().close();
  }
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
