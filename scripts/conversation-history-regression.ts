/** Real library UI on owned panes; HTTP fixtures isolate provider state from rendering. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import type { SavedConversation } from "../shared/conversation-history.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import type { Machine } from "../shared/machines.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-history-ui-"));
const workspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-history", focus: false });
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
const evidence = process.env["UI_EVIDENCE_DIR"];
const releases: Array<() => void> = [];
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ ...(width === 390 ? devices["iPhone 14"] : {}), viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const paneId = workspace.root_pane.pane_id;
    await context.addInitScript(({ theme, paneId }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme }));
      localStorage.setItem(`herdr-web-ui:view:${paneId}`, "chat");
    }, { theme, paneId });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && /same key|unique "key"/i.test(message.text())) errors.push(message.text()); });
    await page.route("**/api/machines/events", (route) => route.abort());
    await page.route("**/api/machines", async (route) => {
      const response = await route.fetch();
      const body: { machines: Machine[] } = await response.json();
      await route.fulfill({ json: { ...body, machines: body.machines.map((machine) => ({ ...machine, name: "QA workstation" })) } });
    });
    const records: SavedConversation[] = ["a", "b", "missing"].map((id) => ({
      id: (id === "missing" ? "c" : id).repeat(64), agent: "omo", title: id === "a" ? "자동 복원 구현" : id === "b" ? "같은 프로젝트의 다른 대화" : "이동된 대화 파일",
      cwd: "/projects/shared-project", updated_at: 1_790_000_000_000, session_id: `session-${id}`,
      pane_id: null, state: id === "missing" ? "unavailable" : "closed", can_resume: id !== "missing", error: id === "missing" ? "Transcript file is unavailable" : null,
    }));
    let resumed = 0;
    let holdOlder = false;
    const olderRelease = Promise.withResolvers<void>();
    releases.push(() => olderRelease.resolve());
    await page.route("**/api/conversations", (route) => route.fulfill({ json: { conversations: records } }));
    await page.route("**/api/conversations/*", async (route) => {
      const url = new URL(route.request().url());
      const id = url.pathname.split("/").at(-1)?.slice(0, 1);
      if (id === "c") return route.fulfill({ status: 404, json: { error: { code: "transcript_missing", message: "Transcript file is unavailable" } } });
      if (url.searchParams.has("before") && holdOlder) {
        holdOlder = false;
        await olderRelease.promise;
        return route.fulfill({ json: {
          source: "omo-transcript", history_id: id, cursor: null,
          turns: [{ role: "user", ts: null, parts: [{ kind: "text", text: "STALE_OLDER_MESSAGE" }] }],
        } satisfies ConversationResponse });
      }
      return route.fulfill({ json: {
        source: "omo-transcript", history_id: id, cursor: url.searchParams.has("before") ? null : "older",
        turns: url.searchParams.has("before")
          ? [{ role: "user", ts: null, parts: [{ kind: "text", text: "EARLIER_MESSAGE" }] }]
          : [{ role: "user", ts: null, parts: [{ kind: "text", text: `SESSION_${id}: 재시작해도 같은 대화를 이어 주세요.` }] },
            { role: "assistant", ts: null, parts: [{ kind: "text", text: "## 저장된 대화\n\n프로젝트가 같아도 대화는 각각 보존합니다.\n\n- 대화 목록 유지\n- 정확한 세션으로 이어가기" },
              { kind: "tool", name: "read", summary: "saved output", input: "notes.md", output: "partial", output_ref: "tool-1" }] }],
      } satisfies ConversationResponse });
    });
    await page.route("**/api/conversations/*/tool-output?*", (route) => route.fulfill({ json: { output: "COMPLETE_SAVED_OUTPUT" } }));
    await page.route("**/api/conversations/*/resume", async (route) => {
      resumed++;
      assert.equal(new URL(route.request().url()).pathname, `/api/conversations/${"b".repeat(64)}/resume`, "resume addresses the selected same-cwd conversation");
      assert.equal(route.request().headers()["x-herdr-machine"], "1");
      await route.fulfill({ json: { pane_id: paneId, workspace_id: workspace.workspace.workspace_id } });
    });
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
    const openHistory = async () => {
      if (width === 390) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.getByRole("button", { name: "Conversation history", exact: true }).click();
      await page.getByRole("dialog", { name: "Conversation history", exact: true }).waitFor();
    };
    await openHistory();
    const dialog = page.getByRole("dialog", { name: "Conversation history", exact: true });
    await dialog.locator(".history-entry").first().waitFor();
    assert.equal(await dialog.locator(".history-entry").count(), 3);
    if (evidence) await dialog.screenshot({ path: join(evidence, `history-list-${width}-${theme}.png`) });
    await dialog.getByRole("button", { name: /자동 복원 구현/ }).click();
    await dialog.getByText("SESSION_a: 재시작해도 같은 대화를 이어 주세요.", { exact: true }).waitFor();
    assert.equal(resumed, 0, "reading an archived conversation never launches an agent");
    holdOlder = true;
    const olderRequested = page.waitForRequest((request) => new URL(request.url()).searchParams.has("before"));
    await dialog.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    await olderRequested;
    const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/conversations/${"a".repeat(64)}` && !new URL(response.url()).search);
    await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
    await (await refreshed).finished();
    await dialog.getByText("SESSION_a: 재시작해도 같은 대화를 이어 주세요.", { exact: true }).waitFor();
    const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.has("before"));
    olderRelease.resolve();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(await dialog.getByText("STALE_OLDER_MESSAGE", { exact: true }).count(), 0, "an earlier page from before refresh cannot replace or duplicate the fresh conversation");
    await dialog.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    await dialog.getByText("EARLIER_MESSAGE", { exact: true }).waitFor();
    await dialog.locator(".saved-work summary").click();
    await dialog.getByRole("button", { name: "Load saved output", exact: true }).click();
    await dialog.getByText("COMPLETE_SAVED_OUTPUT", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (evidence) await dialog.screenshot({ path: join(evidence, `history-preview-${width}-${theme}.png`) });
    if (width === 390) await dialog.getByRole("button", { name: "Back to conversations", exact: true }).click();
    await dialog.getByRole("button", { name: /같은 프로젝트의 다른 대화/ }).click();
    await dialog.getByText("SESSION_b: 재시작해도 같은 대화를 이어 주세요.", { exact: true }).waitFor();
    assert.equal(await dialog.getByText("SESSION_a: 재시작해도 같은 대화를 이어 주세요.", { exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "Resume conversation", exact: true }).click();
    await dialog.waitFor({ state: "detached" }).catch(async (reason: unknown) => {
      console.log("HISTORY_RESUME_ERROR", await dialog.locator('[role="alert"]').allTextContents(), errors);
      if (evidence) await page.screenshot({ path: join(evidence, "history-resume-error.png") });
      throw reason;
    });
    assert.equal(resumed, 1);
    await openHistory();
    await dialog.getByRole("button", { name: /이동된 대화 파일/ }).click();
    await dialog.locator('[role="alert"]').waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Resume conversation", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(`PASS persistent-library UI, same-cwd identity, earlier/tool output, explicit resume and missing record: ${width} ${theme}`);
    await context.close();
  }
} finally {
  for (const release of releases) release();
  await browser.close();
  server.stop();
  await workspaceClose(workspace.workspace.workspace_id);
  rmSync(root, { recursive: true, force: true });
}
