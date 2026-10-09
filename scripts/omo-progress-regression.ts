import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import type { ConversationResponse, OmoActivity, OmoProgress } from "../shared/protocol.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { startShellAgent } from "../server/shell-agent.ts";

/** Real app and owned pane; only public activity and conversation are fictional wire fixtures. */
export async function checkOmoProgress(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-progress-ui-")));
  const workspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-progress", focus: false });
  const paneId = workspace.root_pane.pane_id;
  const evidence = join(import.meta.dir, "../evidence/omo-progress");
  mkdirSync(evidence, { recursive: true });
  const script = join(root, "omo");
  const errors: string[] = [];
  try {
    writeFileSync(script, "process.stdin.resume();\n");
    await startShellAgent("omo", paneId, [], { command: `${process.execPath} ${script}` });
    await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "omo", state: "working" });
    for (const phone of [false, true]) for (const theme of ["dark", "light"]) {
      const context = await browser.newContext({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: phone, hasTouch: phone, locale: "en-US",
      });
      try {
        await context.addInitScript(({ paneId, theme }) => {
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme }));
          localStorage.setItem(`herdr-web-ui:view:${paneId}`, "chat");
        }, { paneId, theme });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        page.on("pageerror", (error) => errors.push(error.message));
        let progress: OmoProgress | null = {
          session_id: "fixture-a", activity: "working",
          todos: [
            { phase: "Build", content: "Inspect the existing session activity path", status: "completed" },
            { phase: "Check", content: "Verify a long checklist entry wraps without covering the message input on a narrow screen", status: "in_progress" },
            { phase: "Check", content: "Check the finished state", status: "pending" },
            { phase: "Check", content: "No longer needed", status: "abandoned" },
          ],
        };
        let failed = false;
        const conversation: ConversationResponse = {
          source: "omo-transcript", history_id: "progress-fixture", cursor: null,
          turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "The fictional guide review is underway." }] }],
        };
        await page.route("**/api/pane/conversation?**", (route) => route.fulfill({ json: conversation }));
        await page.route("**/api/pane/omo-tasks?**", (route) => route.fulfill({
          status: failed ? 503 : 200,
          json: failed ? { error: { code: "unavailable", message: "fixture offline" } } : {
            tasks: [], runs: [], progress, server_time: "2026-10-09T00:00:00Z",
          } satisfies OmoActivity,
        }));
        await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
        const toggle = page.locator(".bg-tasks-toggle");
        await toggle.waitFor();
        assert.equal(await page.locator(".omo-progress").count(), 0, "no pinned progress surface");
        const panel = page.locator(".omo-progress");
        const working = page.locator(".omo-progress.is-working").waitFor();
        await toggle.click();
        await working;
        assert.equal(await panel.locator("details[open]").count(), 0, "checklist starts collapsed");
        await panel.locator("summary").focus();
        await page.keyboard.press("Enter");
        await panel.locator("details[open]").waitFor();
        assert.equal(await panel.locator("li").count(), 4);
        assert.equal(await panel.locator("li.is-abandoned").count(), 1);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        await page.locator(".terminal-stack").screenshot({ path: join(evidence, `${phone ? "phone" : "desktop"}-${theme}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const menuBox = await page.locator(".bg-tasks-menu").boundingBox();
        const inputBox = await page.locator(".composer textarea").boundingBox();
        assert.ok(menuBox && inputBox && menuBox.y + menuBox.height <= inputBox.y, "details stay above input");
        assert.equal(await page.locator(".composer textarea").isEditable(), true);

        // Explicit close/open requests the next fixture immediately; no sleeps or timing-based polls.
        for (const activity of ["compacting", "retrying", "idle"] as const) {
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached" });
          progress = { ...progress, activity };
          const changed = page.locator(`.omo-progress.is-${activity}`).waitFor();
          await toggle.click();
          await changed;
        }
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        failed = true;
        const stale = page.locator('.omo-progress.is-unknown[data-state="failed"]').waitFor();
        await toggle.click();
        await stale;
        await panel.locator("summary").click();
        assert.equal(await panel.locator("li").count(), 4, "failed reads retain checklist without a live claim");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        failed = false;
        progress = { session_id: "fixture-b", activity: "idle", todos: [] };
        const cleared = page.locator(".omo-progress.is-idle").waitFor();
        await toggle.click();
        await cleared;
        await panel.locator("summary").click();
        assert.equal(await panel.locator("li").count(), 0, "session reset replaces old checklist");
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        progress = null; // older bridge
        const unknown = page.locator('.omo-progress.is-unknown[data-state="ready"]').waitFor();
        await toggle.click();
        await unknown;
        assert.equal(await panel.locator(".omo-progress-count").count(), 0);
        await page.reload();
        await toggle.waitFor();
        assert.equal(await panel.count(), 0, "reload never pins or reopens progress");
      } finally { await context.close(); }
    }
    assert.deepEqual(errors, []);
    console.log("PASS OmO opt-in progress, keyboard disclosure, compaction/retry, stale reads, reset and mobile/light/dark layout");
  } finally {
    await workspaceClose(workspace.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}
