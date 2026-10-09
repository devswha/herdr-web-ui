import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-markdown-toc-"));
const sections = ["# 문서 제목", "## 시작", "### **반복 제목**", "### 반복 제목", "#### 상세 설명", "##### 더 깊은 제목", "###### 마지막 단계"];
const content = "---\ntitle: 목차 검증\n---\n\n" + sections.map((title) => `${title}\n\n${"문서 안에서 이동하는 목차를 확인합니다.\n\n".repeat(6)}`).join("\n") + "\n```md\n# 코드 안의 가짜 제목\n```\n\n[다른 문서](next.md)\n";
writeFileSync(join(root, "outline.md"), content);
writeFileSync(join(root, "next.md"), "# 다음 문서\n\n새 파일은 새 목차를 사용합니다.");
writeFileSync(join(root, "plain.md"), "제목 없이 본문만 있는 문서입니다.");
writeFileSync(join(root, "long.md"), "# 긴 문서\n\n" + Array.from({ length: 60 }, (_, index) => `## Section ${index + 1}\n\n${"본문과 목차의 현재 위치가 함께 움직여야 합니다.\n\n".repeat(5)}`).join("\n"));
const workspace = await workspaceCreate({ cwd: root, label: "Markdown outline QA", focus: false });
const paneId = workspace.root_pane.pane_id;
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ ...(width === 390 ? devices["iPhone 14"] : {}), viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(({ paneId, theme }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme, chatFontSize: 18 }));
      localStorage.setItem(`herdr-web-ui:view:${paneId}`, "chat");
    }, { paneId, theme });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/pane/conversation?**", (route) => route.fulfill({ json: {
      source: "omo-transcript", history_id: "outline-test", cursor: null,
      turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "`outline.md`\n\n`plain.md`\n\n`long.md`" }] }],
    } satisfies ConversationResponse }));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".chat-view").getByRole("button", { name: "outline.md", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "outline.md", exact: true });
    await viewer.getByRole("heading", { name: "문서 제목", exact: true }).waitFor();
    const toc = viewer.getByRole("navigation", { name: "Table of contents", exact: true });
    const toggle = viewer.getByRole("button", { name: "Table of contents", exact: true });
    if (width === 390) { assert.equal(await toc.isVisible(), false); await toggle.click(); }
    await toc.waitFor();
    assert.equal(await toc.getByRole("button").count(), 7, "only actual Markdown headings appear");
    assert.deepEqual(await toc.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-level"))), ["1", "2", "3", "3", "4", "5", "6"]);
    const ids = await viewer.locator(".file-viewer-markdown :is(h1,h2,h3,h4,h5,h6)").evaluateAll((headings) => headings.map((heading) => heading.id));
    assert.equal(new Set(ids).size, 7);
    assert.ok(ids.every(Boolean), "each heading has a unique target, including duplicate labels");
    const capture = async (name: string) => {
      if (!evidence) return;
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished)); });
      await page.locator(".file-viewer").screenshot({ path: join(evidence, `${name}-${width}-${theme}.png`) });
    };
    await capture("toc-open");
    const originalUrl = page.url();
    const historyLength = await page.evaluate(() => history.length);
    const secondDuplicate = toc.getByRole("button", { name: "반복 제목", exact: true }).nth(1);
    await secondDuplicate.focus();
    const scrolled = page.waitForEvent("console", { predicate: (message) => message.text() === "TOC_SCROLLED", timeout: 5000 });
    await viewer.locator(".file-viewer-body").evaluate((body) => body.addEventListener("scroll", () => console.info("TOC_SCROLLED"), { once: true }));
    await page.keyboard.press("Enter");
    await scrolled.catch(async (error: unknown) => {
      console.log("TOC_SCROLL_DIAGNOSTIC", await viewer.evaluate((dialog) => [...dialog.querySelectorAll(".file-viewer-content,.file-viewer-body,.file-viewer-markdown,h3")].map((element) => ({
        tag: element.tagName, class: element.className, top: element.getBoundingClientRect().top,
        height: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      }))));
      throw error;
    });
    const selectedHeading = viewer.getByRole("heading", { name: "반복 제목", exact: true }).nth(1);
    const geometry = await selectedHeading.evaluate((heading) => {
      const body = heading.closest(".file-viewer-body");
      if (!body) throw new Error("Missing scroll body");
      const view = body.getBoundingClientRect(), title = heading.getBoundingClientRect();
      return { inset: title.top - view.top, scroll: body.scrollTop, focus: document.activeElement === heading };
    });
    assert.ok(geometry.inset >= 0 && geometry.inset < 30);
    assert.ok(geometry.scroll > 0);
    assert.equal(geometry.focus, true);
    assert.equal(page.url(), originalUrl);
    assert.equal(await page.evaluate(() => history.length), historyLength, "TOC navigation does not add browser history entries");
    if (width === 390) { assert.equal(await toc.isVisible(), false); await toggle.click(); }
    assert.equal(await secondDuplicate.getAttribute("aria-current"), "location");
    await capture("toc-selected");
    if (width === 390) await toggle.click();
    // Scroll independently of the TOC and observe the active section update.
    const observed = page.waitForEvent("console", { predicate: (message) => message.text() === "TOC_CURRENT_LAST", timeout: 5000 });
    await viewer.locator(".file-viewer-toc").evaluate((nav) => {
      const observer = new MutationObserver(() => {
        if (nav.querySelector('[aria-current="location"]')?.textContent?.trim() !== "마지막 단계") return;
        observer.disconnect(); console.info("TOC_CURRENT_LAST");
      });
      observer.observe(nav, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
    });
    await viewer.getByRole("heading", { name: "마지막 단계", exact: true }).evaluate((heading) => {
      const body = heading.closest(".file-viewer-body");
      if (!body) throw new Error("Missing scroll body");
      body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top;
    });
    await observed.catch(async (error: unknown) => {
      console.log("TOC_ACTIVE_DIAGNOSTIC", await viewer.locator('.file-viewer-toc [aria-current]').allTextContents());
      throw error;
    });
    await viewer.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await viewer.getByRole("navigation", { name: "Table of contents", exact: true }).count(), 0);
    assert.equal(await viewer.locator(".file-viewer-text").textContent(), content);
    await viewer.getByRole("button", { name: "Rendered", exact: true }).click();
    await viewer.getByRole("button", { name: "다른 문서", exact: true }).click();
    const next = page.getByRole("dialog", { name: "next.md", exact: true });
    await next.getByRole("heading", { name: "다음 문서", exact: true }).waitFor();
    if (width === 390) await next.getByRole("button", { name: "Table of contents", exact: true }).click();
    assert.equal(await next.getByRole("navigation").getByRole("button").count(), 1);
    await next.getByRole("button", { name: "Close file", exact: true }).click();
    await page.locator(".chat-view").getByRole("button", { name: "plain.md", exact: true }).click();
    const plain = page.getByRole("dialog", { name: "plain.md", exact: true });
    await plain.locator(".file-viewer-markdown").waitFor();
    assert.equal(await plain.getByRole("navigation", { name: "Table of contents", exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await plain.getByRole("button", { name: "Close file", exact: true }).click();
    await page.locator(".chat-view").getByRole("button", { name: "long.md", exact: true }).click();
    const long = page.getByRole("dialog", { name: "long.md", exact: true });
    await long.getByRole("heading", { name: "Section 60", exact: true }).waitFor();
    const longToggle = long.getByRole("button", { name: "Table of contents", exact: true });
    if (width === 390) await longToggle.click();
    const list = long.locator(".file-viewer-toc ol");
    assert.equal(await list.evaluate((node) => node.scrollHeight > node.clientHeight), true, "the fixture must overflow the actual TOC scroll owner");
    const scrollSection = async (title: string) => {
      const active = page.waitForEvent("console", { predicate: (message) => message.text() === `LONG_TOC:${title}`, timeout: 5000 });
      await long.locator(".file-viewer-toc").evaluate((nav, title) => {
        const observer = new MutationObserver(() => {
          if (nav.querySelector('[aria-current="location"]')?.textContent?.trim() !== title) return;
          observer.disconnect(); console.info(`LONG_TOC:${title}`);
        });
        observer.observe(nav, { attributes: true, subtree: true, attributeFilter: ["aria-current"] });
      }, title);
      const focusedBefore = await page.evaluateHandle(() => document.activeElement);
      const expected = await long.getByRole("heading", { name: title, exact: true }).evaluate((heading) => {
        const body = heading.closest(".file-viewer-body");
        if (!body) throw new Error("Missing body");
        body.scrollTop += heading.getBoundingClientRect().top - body.getBoundingClientRect().top - 16;
        return body.scrollTop;
      });
      await active;
      assert.equal(await long.locator(".file-viewer-body").evaluate((body) => body.scrollTop), expected, "revealing the TOC entry must not move the reading position");
      assert.equal(await page.evaluate((previous) => document.activeElement === previous, focusedBefore), true, "TOC following must not steal focus");
      await focusedBefore.dispose();
    };
    const activeVisible = () => list.evaluate((node) => {
      const active = node.querySelector('[aria-current="location"]');
      if (!active) return false;
      const item = active.getBoundingClientRect(), view = node.getBoundingClientRect();
      return node.clientHeight > 0 && item.top >= view.top - 1 && item.bottom <= view.bottom + 1;
    });
    const activeCentered = () => list.evaluate((node) => {
      const active = node.querySelector('[aria-current="location"]');
      if (!active || node.clientHeight === 0) return false;
      const item = active.getBoundingClientRect(), view = node.getBoundingClientRect();
      const desired = node.scrollTop + item.top + item.height / 2 - view.top - node.clientHeight / 2;
      const attainable = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, desired));
      return Math.abs(node.scrollTop - attainable) <= 1;
    });
    await scrollSection("Section 52");
    assert.ok(await list.evaluate((node) => node.scrollTop > 0), "scrolling down the document must also scroll its TOC");
    assert.equal(await activeVisible(), true, "the current heading must be visible in the TOC");
    assert.equal(await activeCentered(), true, "keep the current heading centered as far as the scroll bounds allow");
    const lowerPosition = await list.evaluate((node) => node.scrollTop);
    await capture("toc-follow-down");
    const resized = page.waitForEvent("console", { predicate: (message) => message.text() === "TOC_RESIZED", timeout: 5000 });
    await list.evaluate((node) => {
      const previousHeight = node.clientHeight;
      const settled = () => {
        if (node.clientHeight === previousHeight) return;
        const active = node.querySelector('[aria-current="location"]');
        if (!active) return;
        const item = active.getBoundingClientRect(), view = node.getBoundingClientRect();
        const desired = node.scrollTop + item.top + item.height / 2 - view.top - node.clientHeight / 2;
        const attainable = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, desired));
        if (item.top < view.top - 1 || item.bottom > view.bottom + 1 || Math.abs(node.scrollTop - attainable) > 1) return;
        observer.disconnect(); node.removeEventListener("scroll", settled);
        console.info("TOC_RESIZED");
      };
      // A queued pre-resize scroll is not proof that the resized outline has followed.
      const observer = new ResizeObserver(settled);
      observer.observe(node); node.addEventListener("scroll", settled);
    });
    await page.setViewportSize({ width, height: 480 });
    await resized;
    assert.equal(await activeVisible(), true, "a shorter outline still reveals its current section");
    assert.equal(await activeCentered(), true, "resize keeps the current heading centered");
    await page.setViewportSize({ width, height: 900 });
    await scrollSection("Section 3");
    assert.ok(await list.evaluate((node, lower) => node.scrollTop < lower, lowerPosition), "scrolling back up must bring the TOC back up");
    assert.equal(await activeVisible(), true);
    assert.equal(await activeCentered(), true, "scrolling up centers the current heading, clamping at the start");
    await capture("toc-follow-up");
    await scrollSection("Section 30");
    assert.equal(await activeCentered(), true, "a middle section sits at the center of the outline");
    await capture("toc-follow-middle");
    if (width === 390) {
      await longToggle.click();
      await scrollSection("Section 44");
      await longToggle.click();
      assert.equal(await activeVisible(), true, "reopening a collapsed TOC reveals the current section");
      assert.equal(await activeCentered(), true, "reopening a collapsed TOC centers the current section");
      await capture("toc-follow-reopened");
    }
    assert.deepEqual(errors, []);
    console.log(`PASS TOC: exact navigation, overflow follows down/up, focus/body preservation, mobile reopen and source/file change: ${width} ${theme}`);
    await context.close();
  }
} finally {
  await browser.close(); server.stop(true);
  await workspaceClose(workspace.workspace.workspace_id);
  rmSync(root, { recursive: true, force: true });
}
