/**
 * Favorite agent kinds in the creation picker (components/AgentPicker.tsx): the star beside the
 * picker marks the agent it shows, never changes the selection, is disabled for Shell, and lists
 * the favorites right after Shell in the server's order. Favorites survive a reload and are shared:
 * another browser of the server starts with them, and its change reaches an open page. Agents are
 * a fixed fictional list, so no agent process starts. Captures light and dark at 1365 and 390.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { UsageService } = await import("../server/usage.ts");

const AGENTS = [
  { kind: "claude", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "gemini", label: "Gemini CLI" },
  { kind: "grok", label: "Grok" },
  { kind: "pi", label: "pi" },
];

const root = mkdtempSync(join(tmpdir(), "herdr-agent-favorites-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ?? join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const owned = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-agent-favorites" });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const origin = `http://127.0.0.1:${server.port}`;

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, label);
    await Bun.sleep(50);
  }
}

interface Opened { context: BrowserContext; page: Page; errors: string[] }

/** a browser of its own, as another device would be, offered the fixed agent list */
async function browserAt(browser: Browser, theme: "dark" | "light", width: 1365 | 390): Promise<Opened> {
  const context = await browser.newContext(width === 390
    ? { ...devices["iPhone 14"], viewport: { width: 390, height: 844 }, locale: "en-US", reducedMotion: "reduce" }
    : { viewport: { width: 1365, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  await context.addInitScript((theme) => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme }));
  }, theme);
  await context.route("**/api/agents", (route) => route.fulfill({ json: { agents: AGENTS } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

/** the New workspace dialog with `agent` chosen, through the address as a link would open it */
async function openNew(page: Page, agent: string) {
  await page.goto(`${origin}/?ws=${owned.workspace.workspace_id}&new=workspace&agent=${agent}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  const dialog = page.getByRole("dialog");
  const label = AGENTS.find((entry) => entry.kind === agent)!.label;
  await until(async () => (await dialog.locator(".agent-picker-label").textContent()) === label, `the picker shows ${label}`);
  return dialog;
}

const favorites = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").agentFavorites as string[] | undefined);
const held = async () => (await (await fetch(`${origin}/api/preferences`)).json() as { settings: Record<string, unknown> }).settings["agentFavorites"];

try {
  const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const a = await browserAt(browser, "dark", 1365);
    let dialog = await openNew(a.page, "pi");
    const trigger = dialog.locator(".agent-picker-trigger");
    const shown = () => dialog.locator(".agent-picker-label").textContent();
    const star = dialog.locator(".agent-picker-favorite");
    const starName = () => star.getAttribute("aria-label");
    /** the list's rows, and the rows that carry a favorite's star, read with the list open */
    const listed = async () => {
      if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
      const options = dialog.getByRole("option");
      await options.first().waitFor();
      const rows = await options.allTextContents();
      const starred = await options.filter({ has: a.page.locator(".agent-picker-favorite-mark") }).allTextContents();
      await trigger.press("Escape");
      await until(async () => await trigger.getAttribute("aria-expanded") === "false", "Escape closes the list and leaves the dialog");
      return { rows, starred };
    };

    assert.deepEqual(await listed(), { rows: ["Shell", "Claude Code", "Codex", "Gemini CLI", "Grok", "pi"], starred: [] }, "no favorites: the server's order");
    assert.equal(await starName(), "Add to favorites: pi");
    assert.equal(await star.getAttribute("title"), "Add to favorites: pi");
    await dialog.screenshot({ path: join(evidence, "agent-favorites-not-yet-dark-1365.png") });

    // the star marks the agent it shows and leaves the selection where it was
    await star.click();
    await until(async () => await starName() === "Remove from favorites: pi", "the star now offers to remove pi");
    assert.equal(await star.getAttribute("title"), "Remove from favorites: pi");
    assert.equal(await shown(), "pi", "favoriting does not change the selection");
    assert.deepEqual(await favorites(a.page), ["pi"]);
    assert.deepEqual(await listed(), { rows: ["Shell", "pi", "Claude Code", "Codex", "Gemini CLI", "Grok"], starred: ["pi"] });

    await trigger.click();
    await dialog.getByRole("option").filter({ hasText: /^Codex$/ }).click();
    await until(async () => await shown() === "Codex", "Codex is chosen from the list");
    assert.equal(await starName(), "Add to favorites: Codex");
    await star.click();
    await until(async () => await starName() === "Remove from favorites: Codex", "the star now offers to remove Codex");
    assert.deepEqual(await favorites(a.page), ["pi", "codex"]);
    // favorites follow Shell in the server's order, not the order they were starred in
    assert.deepEqual(await listed(), { rows: ["Shell", "Codex", "pi", "Claude Code", "Gemini CLI", "Grok"], starred: ["Codex", "pi"] });

    // a press with the list open closes it and still keeps the selection
    await trigger.click();
    await dialog.getByRole("option").first().waitFor();
    await star.click();
    await until(async () => await trigger.getAttribute("aria-expanded") === "false", "the star closes an open list");
    assert.equal(await shown(), "Codex");
    assert.deepEqual(await favorites(a.page), ["pi"]);
    await star.click();
    assert.deepEqual(await favorites(a.page), ["pi", "codex"]);

    // Shell is never a favorite: its star is disabled
    await trigger.press("ArrowDown");
    await trigger.press("Home");
    await trigger.press("Enter");
    await until(async () => await shown() === "Shell", "Shell is chosen with the keyboard");
    assert.equal(await star.isDisabled(), true, "the star is disabled for Shell");
    assert.equal(await starName(), "Add to favorites: Shell");
    assert.deepEqual(await favorites(a.page), ["pi", "codex"]);
    await dialog.screenshot({ path: join(evidence, "agent-favorites-shell-dark-1365.png") });

    // kept across a reload, here and on the server
    await until(async () => JSON.stringify(await held()) === JSON.stringify(["pi", "codex"]), "the server holds the favorites");
    dialog = await openNew(a.page, "codex");
    assert.equal(await dialog.locator(".agent-picker-favorite").getAttribute("aria-label"), "Remove from favorites: Codex");
    assert.deepEqual(await listed(), { rows: ["Shell", "Codex", "pi", "Claude Code", "Gemini CLI", "Grok"], starred: ["Codex", "pi"] });
    console.log("PASS favorite agents: star labels, selection kept, Shell disabled, server order after Shell, kept across a reload");

    // shared: another device starts with them, and its change reaches the open page
    const b = await browserAt(browser, "dark", 1365);
    const other = await openNew(b.page, "pi");
    const otherStar = other.locator(".agent-picker-favorite");
    await until(async () => await otherStar.getAttribute("aria-label") === "Remove from favorites: pi", "a new device takes the shared favorites");
    await otherStar.click();
    await until(async () => JSON.stringify(await favorites(a.page)) === JSON.stringify(["codex"]), "the open page takes the other device's change");
    await otherStar.click();
    await until(async () => JSON.stringify(await favorites(a.page)) === JSON.stringify(["codex", "pi"]), "and its next one");
    await until(async () => await a.page.locator(".agent-picker-favorite").getAttribute("aria-label") === "Remove from favorites: Codex", "the open dialog still marks Codex");
    assert.deepEqual([...a.errors, ...b.errors], []);
    await a.context.close();
    await b.context.close();
    console.log("PASS favorite agents are shared: a new device starts with them, a change reaches an open page");

    for (const theme of ["dark", "light"] as const) {
      for (const width of [1365, 390] as const) {
        const opened = await browserAt(browser, theme, width);
        const shot = await openNew(opened.page, "codex");
        const pickerStar = shot.locator(".agent-picker-favorite");
        await until(async () => await pickerStar.getAttribute("aria-label") === "Remove from favorites: Codex", `${theme} ${width}: Codex is a favorite`);
        const starBox = (await pickerStar.boundingBox())!;
        const triggerBox = (await shot.locator(".agent-picker-trigger").boundingBox())!;
        assert.equal(starBox.height, triggerBox.height, `${theme} ${width}: the star is as tall as the picker`);
        assert.ok(starBox.width >= 24 && starBox.height >= 24, `${theme} ${width}: the star is at least 24px square`);
        assert.equal(Math.round(starBox.y), Math.round(triggerBox.y), `${theme} ${width}: the star sits level with the picker`);
        assert.equal(await opened.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme} ${width}: no sideways scroll`);
        await opened.page.screenshot({ path: join(evidence, `agent-favorites-${theme}-${width}.png`) });
        await shot.locator(".agent-picker-trigger").click();
        await shot.getByRole("option").first().waitFor();
        await opened.page.screenshot({ path: join(evidence, `agent-favorites-list-${theme}-${width}.png`) });
        assert.deepEqual(opened.errors, []);
        await opened.context.close();
      }
    }
    console.log(`PASS favorite agents drawn in light and dark at 1365 and 390; captures in ${evidence}`);
  } finally {
    await browser.close();
  }
} finally {
  server.stop();
  await workspaceClose(owned.workspace.workspace_id);
  if (!process.env["UI_EVIDENCE_DIR"]) console.log(`evidence kept in ${evidence}`);
  else rmSync(root, { recursive: true, force: true });
}
