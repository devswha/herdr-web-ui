/// <reference types="bun" />
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A finger reorders the sidebar's workspaces (src/lib/touchReorder.ts), on the unmodified app over
// the demo's fixture transport at a phone's size with touch: a long press lifts a row, a drag drops
// it where the line shows, a quick stroke only scrolls, and Alt+Up moves it a step without pane actions in the workspace menu.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-touch-reorder-demo-"));

/** the top-level rows, in the order the sidebar draws them */
const topRows = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace ?? ""));
const serverOrder = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[] }).workspaces.map((workspace) => workspace.workspace_id));
const centerOf = async (page: Page, id: string) => {
  const box = await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).boundingBox();
  assert.ok(box, `row ${id} is on screen`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });

/** A finger moves after the row lifts, or immediately for a quick scroll stroke. */
async function stroke(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number, during?: () => Promise<void>): Promise<void> {
  await touch(cdp, "touchStart", from);
  if (holdMs > 0) await page.locator(".workspace.is-lifted").waitFor({ timeout: 5_000 });
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await touch(cdp, "touchMove", { x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await during?.();
  await touch(cdp, "touchEnd");
}

const pinnedRows = (page: Page) => page.locator(".workspace-list-pinned > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));

/** Both input methods change saved pins, never the transport's workspace roster. */
/** The demo has two repositories: a third top-level workspace gives a drag a row to pass. */
async function addScratchWorkspace(page: Page): Promise<string> {
  const scratch = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/home/demo/scratch", label: "scratch" }) });
    if (!response.ok) throw new Error(`create demo workspace: ${response.status}`);
    return (await response.json() as { workspace_id: string }).workspace_id;
  });
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${scratch}"]`).waitFor();
  return scratch;
}

async function checkPinned(page: Page, cdp?: CDPSession): Promise<void> {
  if ((await topRows(page)).length < 3) await addScratchWorkspace(page);
  const before = await topRows(page);
  const ids = before.slice(0, 2);
  assert.equal(ids.length, 2);
  const child = await page.evaluate(async (workspaceId) => {
    const response = await fetch("/api/worktree/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, branch: "pinned-reorder-child" }),
    });
    if (!response.ok) throw new Error(`create demo worktree: ${response.status}`);
    return (await response.json() as { workspace_id: string }).workspace_id;
  }, ids[0]);
  await page.locator(`.worktree-children .workspace-group[data-workspace="${child}"]`).waitFor();
  const serverBefore = await serverOrder(page);
  const row = (id: string) => page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`);
  for (const id of ids) {
    if (cdp) await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .row-menu-toggle`).click();
    else await row(id!).click({ button: "right" });
    await page.getByRole(cdp ? "button" : "menuitem", { name: "Pin workspace", exact: true }).click();
  }
  assert.deepEqual(await pinnedRows(page), ids);
  const restRows = () => page.locator(".machine-workspaces .sidebar-list > .workspace-list:not(.workspace-list-pinned) > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));
  const restBefore = await restRows();
  const drag = async (source: string, target: string) => {
    if (cdp) await stroke(page, cdp, await centerOf(page, source), await centerOf(page, target), 1);
    else await row(source).dragTo(row(target));
  };
  await drag(ids[0]!, ids[1]!);
  const expected = [ids[1], ids[0]];
  assert.deepEqual(await pinnedRows(page), expected, "drag changes the pinned card order");
  assert.equal(await page.locator(".workspace-list-pinned .worktree-children").count(), 0, "pinned repository rows do not carry their worktrees into the card");
  const childRow = row(child);
  assert.equal(await childRow.evaluate((element) => element.closest(".sidebar-pinned, .worktree-children") === null), true, "the unpinned worktree stands alone outside the card");
  assert.equal(await childRow.getAttribute("draggable"), "false", "the unpinned worktree stays fixed");
  assert.deepEqual(await restRows(), restBefore, "reordering the pinned repository leaves its worktree at the original rest-list position");
  await row(ids[0]!).focus();
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await pinnedRows(page), ids, "Alt+Up reorders pinned rows within the card");
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await pinnedRows(page), expected, "Alt+Down restores the pinned order");
  await childRow.focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await restRows(), restBefore, "Alt+Down cannot move the repository's unpinned worktree");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]") as string[]);
  assert.deepEqual(stored.filter((key) => key.includes(":workspace:")).map((key) => key.split(":workspace:")[1]), expected, "the pin list holds the new order");
  const unpinned = before[2]!;
  await drag(ids[0]!, unpinned);
  await drag(unpinned, ids[0]!);
  assert.deepEqual(await pinnedRows(page), expected, "neither direction crosses the pin boundary");
  await drag(ids[0]!, child);
  assert.deepEqual(await pinnedRows(page), expected, "dropping onto the repository's own worktree cannot cross the card edge");
  assert.deepEqual(await restRows(), restBefore, "cross-card drops leave the rest list unchanged");
  assert.deepEqual(await serverOrder(page), serverBefore, "pinned drags never move herdr workspaces");
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `pinned-reorder-${cdp ? "phone" : "desktop"}.png`) });
  }
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  const toggle = page.locator('button[aria-controls="workspace-drawer"]');
  if (cdp && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.locator(".workspace-list-pinned").waitFor();
  assert.deepEqual(await pinnedRows(page), expected, "pin order survives reload");
  console.log(`PASS ${cdp ? "touch long press" : "desktop drag"} and Alt+Up/Down reorder saved pins within the card, keep unpinned worktrees fixed outside, preserve herdr order and survive reload`);
}

type Hooks = Record<string, (...args: never[]) => unknown>;
/** a call into the demo server's order controls (site/demo/transport.ts) */
const demo = <T = unknown>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(([name, args]) => ((window as unknown as { __herdrDemoOrder: Hooks }).__herdrDemoOrder[name as string] as (...a: unknown[]) => unknown)(...(args as unknown[])), [name, args] as const) as Promise<T>;
const localTop = (page: Page) => page.evaluate(() => [...document.querySelector(".machine-workspaces")!.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace ?? ""));
/** every order the first PC's list was drawn in, recorded by a MutationObserver from page load */
const drawnOrders = (page: Page) => page.evaluate(() => (window as unknown as { __orderCommits: string[] }).__orderCommits.slice());
const waitOrder = (page: Page, want: readonly string[], label: string) => page.waitForFunction((want) =>
  [...document.querySelector(".machine-workspaces")!.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(), want, { timeout: 10_000 })
  .catch(async () => { throw new Error(`${label}: wanted ${want.join()} got ${(await localTop(page)).join()}`); });
const logCount = (page: Page, kind: string) => page.evaluate((kind) => ((window as unknown as { __herdrDemoOrder: { log(): { kind: string }[] } }).__herdrDemoOrder.log()).filter((entry) => entry.kind === kind).length, kind);
const waitLog = (page: Page, kind: string, count: number) => page.waitForFunction(([kind, count]) =>
  ((window as unknown as { __herdrDemoOrder: { log(): { kind: string }[] } }).__herdrDemoOrder.log()).filter((entry) => entry.kind === kind).length >= (count as number), [kind, count] as const, { timeout: 10_000 });
let markerStatus: "working" | "idle" = "idle";
/**
 * A pane-status patch after a delivery: once its badge shows, every frame before it was drawn. The
 * marker is an agent pane alone in its workspace, so the row's badge is that pane's own status.
 */
async function drawn(page: Page): Promise<void> {
  const marker = await page.evaluate(async () => {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; workspace_id: string; agent: string | null }[] } };
    const alone = snapshot.panes.find((pane) => pane.agent && snapshot.panes.filter((other) => other.workspace_id === pane.workspace_id).length === 1);
    return alone ? { pane: alone.pane_id, workspace: alone.workspace_id } : null;
  });
  assert.ok(marker, "the demo has an agent pane alone in its workspace");
  markerStatus = markerStatus === "idle" ? "working" : "idle";
  await demo(page, "status", marker.pane, markerStatus);
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${marker.workspace}"] > .workspace-header [data-status="${markerStatus}"]`).first().waitFor({ state: "attached", timeout: 10_000 });
}
/** Alt+Up on a top-level row: the keyboard's reorder, one group up */
async function stepUp(page: Page, id: string): Promise<void> {
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).first().focus();
  await page.keyboard.press("Alt+ArrowUp");
}
const up = (order: readonly string[], id: string) => { const next = [...order]; const index = next.indexOf(id); [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; };
/**
 * One keyboard step of a workspace with no worktrees: exactly one move, so its receipt's epoch is
 * settled when the server logs it. Up when it can, else down. The order it shows.
 */
async function stepOne(page: Page, order: readonly string[], id: string): Promise<string[]> {
  const index = order.indexOf(id);
  const next = [...order];
  const other = index > 0 ? index - 1 : index + 1;
  [next[other], next[index]] = [next[index]!, next[other]!];
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).first().focus();
  await page.keyboard.press(index > 0 ? "Alt+ArrowUp" : "Alt+ArrowDown");
  return next;
}
/** herdr's own order of the rows the sidebar shows at the top level */
const herdrTop = async (page: Page, rows: readonly string[]) => (await serverOrder(page)).filter((id) => rows.includes(id));
/** where the drawn-order record stands now: a case checks only what was drawn after its own drag */
const drawnMark = async (page: Page) => (await drawnOrders(page)).length;
async function neverDrawnSince(page: Page, since: number, order: readonly string[], label: string): Promise<string[]> {
  const drawnNow = (await drawnOrders(page)).slice(since);
  assert.ok(!drawnNow.includes(order.join()), `${label}: ${order.join()} was drawn again (${drawnNow.join(" | ")})`);
  return drawnNow;
}

/**
 * Workspace order evidence (lib/workspaceOrder.ts) on the demo server: each case holds reads, cached
 * GETs, SSE rosters, move answers and boot proofs apart and arms its wait before the step it waits on.
 */
async function checkOrderEvidence(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string): Promise<{ happy: unknown; failure: unknown }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addInitScript(() => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    const commits: string[] = [];
    (window as unknown as { __orderCommits: string[] }).__orderCommits = commits;
    new MutationObserver(() => {
      const list = document.querySelector(".machine-workspaces");
      if (!list) return;
      const order = [...list.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join();
      if (order && order !== commits.at(-1)) commits.push(order);
    }).observe(document, { subtree: true, childList: true });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  const single = await addScratchWorkspace(page);
  const happy: Record<string, unknown> = {};
  const failure: Record<string, unknown> = {};

  // happy: a read started before the move, delivered after it by SSE and as the settlement's cached GET, cannot undo it
  const O = await localTop(page);
  const epoch = await demo<string>(page, "epoch");
  await demo(page, "holdSse", true);
  const stale = await demo<number>(page, "hold");
  await demo(page, "cacheNextGet", stale);
  const reads = await logCount(page, "read-start");
  const A = up(O, O[1]!);
  const happySince = await drawnMark(page);
  await stepUp(page, O[1]!);
  await waitOrder(page, A, "the dragged order shows at once");
  await waitLog(page, "move", 1);
  await waitLog(page, "read-start", reads + 1);
  await demo(page, "deliverSse", stale);
  await drawn(page);
  assert.deepEqual(await localTop(page), A, "a pre-move read delivered after the receipt keeps the dragged order");
  // until another order legitimately replaces it (which may even equal O), O is never drawn
  const happyDrawn = await neverDrawnSince(page, happySince, O, "the pre-move order O after the drag");
  // another client moves again; the first full roster read after both is B, not an echo of A
  await demo(page, "otherClientMove", A[2]!, 1);
  const B = await herdrTop(page, A);
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, B, "B shows on the first qualifying SSE roster");
  // the same through App's polled load: publication held, the settlement's load reads afresh
  await demo(page, "holdSse", true);
  const C = up(B, B[1]!);
  await stepUp(page, B[1]!);
  await waitOrder(page, C, "a second drag shows at once");
  const loadsBefore = await logCount(page, "read-start");
  await waitLog(page, "read-start", loadsBefore + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), C, "the polled load read after the move keeps C");
  await demo(page, "holdSse", false);
  Object.assign(happy, { epoch, O, A, B, C, drawn_while_held: happyDrawn, log: await demo(page, "log") });
  console.log("PASS reorder-holds-through-snapshot: a pre-move SSE roster and cached GET keep the dragged order; B shows on the first qualifying roster by SSE and by load");

  // failure: a pre-move read delivered at frozen and backward clocks; a pane-status patch; another PC
  await demo(page, "addPc");
  await page.locator(".machine-workspaces").nth(1).waitFor({ state: "attached" });
  await demo(page, "holdSse", true);
  await page.evaluate(() => { const w = window as unknown as { __realNow: () => number }; w.__realNow = Date.now; Date.now = () => 2_000_000_000_000; });
  const frozen = await demo<number>(page, "hold");
  const D0 = await localTop(page);
  const D = up(D0, D0[2]!);
  const movesBeforeFrozen = await logCount(page, "move");
  const frozenSince = await drawnMark(page);
  await stepUp(page, D0[2]!);
  await waitOrder(page, D, "a drag under a frozen clock shows at once");
  await waitLog(page, "move", movesBeforeFrozen + 1);
  await page.evaluate(() => { Date.now = () => 1_000_000_000_000; });
  await demo(page, "deliverSse", frozen);
  await demo(page, "status", "w1C:p1", "blocked");
  await drawn(page);
  assert.deepEqual(await localTop(page), D, "a frozen then backward clock, a status patch and another PC's roster cannot release");
  await page.evaluate(() => { Date.now = (window as unknown as { __realNow: () => number }).__realNow; });
  await demo(page, "status", "w1C:p1", "working");
  failure["clock_status_other_pc"] = { before: D0, order: D, drawn_after_drag: await neverDrawnSince(page, frozenSince, D0, "the pre-move order under frozen clocks") };

  // multiple generations: a new drag before the first one's moves answer; the newest order stays
  await demo(page, "holdMoves", true);
  const G1 = up(D, D[1]!);
  await stepUp(page, D[1]!);
  await waitOrder(page, G1, "the first generation shows");
  const G2 = up(G1, G1[2]!);
  await stepUp(page, G1[2]!);
  await waitOrder(page, G2, "the newer generation shows at once");
  await page.waitForFunction(() => (window as unknown as { __herdrDemoOrder: { pendingMoves(): number } }).__herdrDemoOrder.pendingMoves() > 0, undefined, { timeout: 10_000 });
  await demo(page, "releaseMove");
  await drawn(page);
  assert.deepEqual(await localTop(page), G2, "an older generation's answer does not replace the newer order");
  await demo(page, "releaseAllMoves");
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, G2, "the settled generations land where the newest drag put them");
  failure["generations"] = { G1, G2 };

  // a wrong-epoch roster alone cannot release; a refused proof keeps everything; a later mismatch asks again
  await demo(page, "verifyMode", "refuse");
  await demo(page, "holdSse", true);
  const beforeRestart = await demo<number>(page, "hold");
  const movesBeforeRestart = await logCount(page, "move");
  const restartSince = await drawnMark(page);
  const R = await stepOne(page, G2, single);
  await waitOrder(page, R, "the drag before the restart shows");
  await waitLog(page, "move", movesBeforeRestart + 1);
  const oldEpoch = await demo<string>(page, "epoch");
  const newEpoch = await demo<string>(page, "restart");
  await demo(page, "otherClientMove", R[2]!, 1);
  const S = await herdrTop(page, R);
  const refusals = await logCount(page, "verify-refuse");
  await demo(page, "publish");
  await waitLog(page, "verify-refuse", refusals + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), R, "another epoch's roster without proof cannot replace the order");
  const restartDrawn = await neverDrawnSince(page, restartSince, G2, "the pre-move order across the restart");
  await demo(page, "verifyMode", "answer");
  const answers = await logCount(page, "verify-answer");
  await demo(page, "publish");
  await waitLog(page, "verify-answer", answers + 1);
  await waitOrder(page, S, "the correlated proof retires the old epoch and applies the new server's roster");
  const settledMark = await drawnMark(page);
  // the held pre-restart roster, by SSE and as a cached GET, cannot bring the old order back
  await demo(page, "deliverSse", beforeRestart);
  await demo(page, "cacheNextGet", beforeRestart);
  const polls = await logCount(page, "read-start");
  await waitLog(page, "read-start", polls + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), S, "a retired epoch's SSE roster and cached GET change nothing");
  assert.deepEqual((await drawnOrders(page)).slice(settledMark), [], "nothing was drawn after the new server's order");
  failure["restart"] = { before: G2, oldEpoch, newEpoch, R, S, drawn_while_held: restartDrawn };

  // round 6: a receipt, then proof of a successor with no snapshot of it, then another restart before any
  await demo(page, "verifyMode", "proof-only");
  const guardSince = await drawnMark(page);
  const movesBeforeGuard = await logCount(page, "move");
  const T = await stepOne(page, S, single);
  await waitOrder(page, T, "the drag after the restart shows");
  await waitLog(page, "move", movesBeforeGuard + 1);
  await demo(page, "restart");
  const proofs = await logCount(page, "verify-proof-only");
  await demo(page, "publish");
  await waitLog(page, "verify-proof-only", proofs + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), T, "proof alone applies no snapshot");
  const guardDrawn = await neverDrawnSince(page, guardSince, S, "the pre-move order across two restarts");
  await demo(page, "restart");
  await demo(page, "verifyMode", "answer");
  await demo(page, "otherClientMove", T[2]!, 1);
  const U = await herdrTop(page, T);
  const finalAnswers = await logCount(page, "verify-answer");
  await demo(page, "publish");
  await waitLog(page, "verify-answer", finalAnswers + 1);
  await waitOrder(page, U, "the guard alone verifies the second restart and applies its full roster");
  failure["successor_guard"] = { before: S, T, U, drawn_while_held: guardDrawn };

  assert.deepEqual(errors, []);
  Object.assign(failure, { drawn: await drawnOrders(page), log: await demo(page, "log") });
  await context.close();
  console.log("PASS superseded-reorder-failure: frozen/backward clocks, status patches, another PC, older generations, unproved and retired epochs, a proof-only successor and an older server's fallback never undo the newest order");
  return { happy, failure };
}

/** An older server (no pairs, receipts without numbers) on a PC never protected: the fallback, on its own page. */
async function checkLegacyFallback(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string): Promise<unknown> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  await demo(page, "legacy", true);
  await addScratchWorkspace(page);
  const U = await localTop(page);
  await demo(page, "holdSse", true);
  await demo(page, "holdMoves", true);
  const legacyStale = await demo<number>(page, "hold");
  const V = up(U, U[1]!);
  await stepUp(page, U[1]!);
  await waitOrder(page, V, "an older server's drag shows at once");
  await page.waitForFunction(() => (window as unknown as { __herdrDemoOrder: { pendingMoves(): number } }).__herdrDemoOrder.pendingMoves() > 0, undefined, { timeout: 10_000 });
  await demo(page, "deliverSse", legacyStale);
  await drawn(page);
  assert.deepEqual(await localTop(page), V, "a roster delivered before settlement cannot release the fallback hold");
  const legacyLoads = await logCount(page, "read-start");
  await demo(page, "releaseAllMoves");
  await waitLog(page, "read-start", legacyLoads + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), V, "the load started after settlement shows herdr's order");
  await demo(page, "otherClientMove", V[2]!, 1);
  const W = await herdrTop(page, V);
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, W, "after the post-settlement load, an older server's roster applies as before");
  await context.close();
  console.log("PASS an older server's move falls back to the first load started after settlement");
  return { U, V, W };
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

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
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator('button[aria-controls="workspace-drawer"]').click();
      await page.locator(".machine-workspaces .workspace-group").first().waitFor();
      const cdp = await context.newCDPSession(page);

      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone context has a coarse pointer");
      assert.equal(await page.locator(".machine-workspaces .workspace-select").first().getAttribute("draggable"), "false",
        "on a touch screen the browser's own drag is off, so iOS lifts no drag preview that drops nothing");

      await addScratchWorkspace(page);
      const before = await topRows(page);
      assert.ok(before.length >= 3, `three top-level workspaces: ${JSON.stringify(before)}`);
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), before, "the sidebar draws herdr's order");

      // a quick stroke is a scroll, not a lift
      await stroke(page, cdp, await centerOf(page, before[0]!), await centerOf(page, before[2]!), 0, async () => {
        assert.equal(await page.locator(".workspace.is-lifted").count(), 0, "a stroke that moves at once lifts nothing");
      });
      assert.deepEqual(await topRows(page), before, "a quick stroke moves nothing");

      // a long press lifts the first row; dragged past the third and let go, it lands after it
      const target = await centerOf(page, before[2]!);
      await stroke(page, cdp, await centerOf(page, before[0]!), { x: target.x, y: target.y + 4 }, 600, async () => {
        assert.equal(await page.locator(`.workspace-group.is-lifted[data-workspace="${before[0]}"]`).count(), 1, "the held row is lifted");
        assert.ok(await page.locator(`.machine-workspaces [data-drop="after"]`).count() === 1, "a line shows where it lands");
        assert.notEqual(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the row follows the finger");
      });
      const expected = [before[1]!, before[2]!, before[0]!, ...before.slice(3)];
      await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
        expected, { timeout: 5_000 });
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), expected, "herdr got the move");
      assert.equal(await page.locator(".workspace.is-lifted, [data-drop]").count(), 0, "nothing stays lifted or marked");
      assert.equal(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the dropped row sits in the list");
      assert.equal(await page.locator('button[aria-controls="workspace-drawer"]').getAttribute("aria-expanded"), "true", "the drag left the drawer open");
      console.log("PASS a long press lifts a workspace row on a touch screen, and a drag drops it where the line shows");

      // The phone's explicit menu has the same workspace scope as desktop right-click.
      const moved = before[0]!;
      const movedRow = page.locator(`.workspace-group[data-workspace="${moved}"]`);
      await movedRow.locator(".row-menu-toggle").click();
      const workspaceSheet = page.locator(".row-sheet");
      await workspaceSheet.waitFor();
      assert.deepEqual(await workspaceSheet.locator(".row-sheet-item").allTextContents(), ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close group", "New worktree", "Open worktree…", "Collapse"],
        "the touch menu of a repository contains its group's native actions, with no pane or reorder actions");
      await workspaceSheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await workspaceSheet.waitFor({ state: "detached" });
      // Keyboard reordering remains available on the row itself.
      await movedRow.locator(".workspace-select").focus();
      await page.keyboard.press("Alt+ArrowUp");
      const stepped = [before[1]!, before[0]!, before[2]!, ...before.slice(3)];
      await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
        stepped, { timeout: 5_000 });
      assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), stepped, "herdr got the keyboard move");
      console.log("PASS the touch menu keeps workspace scope and Alt+Up still moves a workspace one step");

      await checkPinned(page, cdp);
      assert.deepEqual(errors, []);
      await context.close();
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
      await desktop.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const desktopPage = await desktop.newPage();
      await desktopPage.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      await desktopPage.locator(".conn-live").waitFor({ state: "attached" });
      await desktopPage.locator(".machine-workspaces .workspace-group").first().waitFor();
      await checkPinned(desktopPage);
      await desktop.close();
      const order = await checkOrderEvidence(browser, `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      (order.failure as Record<string, unknown>)["legacy_fallback"] = await checkLegacyFallback(browser, `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
      const evidence = process.env["UI_EVIDENCE_DIR"];
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, "reorder-holds-through-snapshot.json"), JSON.stringify(order.happy, null, 2));
        writeFileSync(join(evidence, "superseded-reorder-failure.json"), JSON.stringify(order.failure, null, 2));
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
