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

const root = mkdtempSync(join(tmpdir(), "herdr-markdown-preview-"));
const docs = join(root, "docs");
mkdirSync(docs);
const markdown = "# 프로젝트 문서\n\n일반 문장이 **굵은 글씨**와 *기울임*으로 보입니다.\n\n## 작업 목록\n\n- 첫 번째 항목\n- 두 번째 항목\n\n| 항목 | 상태 |\n| --- | --- |\n| 렌더링 | 완료 |\n\n```ts\nconst answer = 42;\n```\n\n> 중요한 문장입니다.\n\n수식: \\(x^2 + y^2 = z^2\\)\n\n[다음 문서](next.md)\n\n<script>window.MARKDOWN_EXECUTED = true</script>\n";
writeFileSync(join(docs, "guide.md"), markdown);
writeFileSync(join(docs, "next.md"), "# 다음 문서\n\n문서 폴더 기준으로 연결되었습니다.");
writeFileSync(join(docs, "plain.txt"), markdown);
writeFileSync(join(docs, "large.markdown"), "# 큰 문서\n\n" + "bounded preview\n".repeat(25_000));
const styledMarkdown = "---\ntitle: 제목 위계 확인\ntags:\n  - preview\n---\n\n# 1단계 제목\n\n본문 **굵은 글씨**입니다.\n\n## 2단계 제목\n\n### 3단계 제목\n\n#### 4단계 제목\n\n##### 5단계 제목\n\n###### 6단계 제목\n\n- 목록\n  - 하위 항목\n\n---\n\n> 인용문\n";
writeFileSync(join(docs, "style.md"), styledMarkdown);
const workspace = await workspaceCreate({ cwd: root, label: "Markdown preview QA", focus: false });
const paneId = workspace.root_pane.pane_id;
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ ...(width === 390 ? devices["iPhone 14"] : {}), viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await context.addInitScript(({ paneId, theme }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme, chatFontSize: 20 }));
      localStorage.setItem(`herdr-web-ui:view:${paneId}`, "chat");
    }, { paneId, theme });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const capture = async (name: string) => {
      if (!evidence) return;
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished));
      });
      await page.locator(".file-viewer").screenshot({ path: join(evidence, name) });
    };
    await page.route("**/api/pane/conversation?**", (route) => route.fulfill({ json: {
      source: "omo-transcript", history_id: "markdown-preview", cursor: null,
      turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "`docs/guide.md`\n\n`docs/plain.txt`\n\n`docs/large.markdown`\n\n`docs/style.md`" }] }],
    } satisfies ConversationResponse }));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(".chat-view").getByRole("button", { name: "docs/style.md", exact: true }).click();
    const styleViewer = page.getByRole("dialog", { name: "style.md", exact: true });
    await styleViewer.getByRole("heading", { name: "6단계 제목", exact: true }).waitFor();
    await capture(`markdown-properties-${width}-${theme}.png`);
    const styles = await styleViewer.evaluate((dialog) => {
      const body = dialog.querySelector(".file-viewer-body");
      const prose = dialog.querySelector(".file-viewer-markdown .markdown");
      const chat = document.querySelector(".chat-view");
      const chatProse = chat?.querySelector(".markdown");
      if (!body || !prose || !chat || !chatProse) throw new Error("Missing document or chat surface");
      return { background: getComputedStyle(body).backgroundColor, themeBackground: getComputedStyle(chat).backgroundColor,
        fontSize: parseFloat(getComputedStyle(prose).fontSize), width: prose.getBoundingClientRect().width,
        chatFontSize: parseFloat(getComputedStyle(chatProse).fontSize),
        contentWidth: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--content-w")) };
    });
    assert.equal(styles.background, styles.themeBackground, "document follows the selected app theme");
    assert.equal(styles.fontSize, styles.chatFontSize, "document text follows the chat's current font scale");
    assert.ok(styles.width <= styles.contentWidth);
    assert.equal(await styleViewer.locator(".file-viewer-properties").getAttribute("open"), null);
    await styleViewer.getByText("Document properties", { exact: true }).click();
    assert.equal(await styleViewer.locator(".file-viewer-properties pre").textContent(), "title: 제목 위계 확인\ntags:\n  - preview");
    await styleViewer.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await styleViewer.locator(".file-viewer-text").textContent(), styledMarkdown, "source preserves the complete frontmatter");
    assert.equal(await styleViewer.locator(".file-viewer-text").evaluate((node) => parseFloat(getComputedStyle(node).fontSize)), styles.chatFontSize);
    await styleViewer.getByRole("button", { name: "Close file", exact: true }).click();
    await page.locator(".chat-view").getByRole("button", { name: "docs/guide.md", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "guide.md", exact: true });
    await viewer.getByRole("heading", { name: "프로젝트 문서", exact: true }).waitFor();
    assert.equal(await viewer.getByRole("button", { name: "Rendered", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await viewer.locator(".markdown strong").textContent(), "굵은 글씨");
    assert.equal(await viewer.locator(".markdown table tbody tr").count(), 1);
    assert.equal(await viewer.locator(".markdown-code code").textContent(), "const answer = 42;");
    await viewer.locator(".katex").waitFor();
    assert.equal(await viewer.locator(".katex").count(), 1);
    assert.equal(await viewer.locator(".file-viewer-markdown script").count(), 0);
    assert.equal(await page.evaluate(() => Object.hasOwn(window, "MARKDOWN_EXECUTED")), false);
    assert.equal(await viewer.locator(".file-viewer-markdown .markdown").evaluate((node) => parseFloat(getComputedStyle(node).fontSize)), styles.chatFontSize);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await capture(`markdown-rendered-${width}-${theme}.png`);
    await viewer.getByRole("button", { name: "Source", exact: true }).click();
    await viewer.locator(".file-viewer-text").waitFor();
    assert.equal(await viewer.locator(".file-viewer-text").textContent(), markdown);
    assert.equal(await viewer.getByRole("button", { name: "Source", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await viewer.getByRole("button", { name: "Rendered", exact: true }).getAttribute("aria-pressed"), "false");
    await capture(`markdown-source-${width}-${theme}.png`);
    const original = viewer.getByRole("link", { name: "Open original in a new tab", exact: true });
    const href = await original.getAttribute("href");
    if (!href) throw new Error("Missing original link");
    assert.equal(await (await page.request.get(new URL(href, page.url()).toString())).text(), markdown);
    await viewer.getByRole("button", { name: "Rendered", exact: true }).click();
    await viewer.getByRole("button", { name: "다음 문서", exact: true }).click();
    const next = page.getByRole("dialog", { name: "next.md", exact: true });
    await next.getByRole("heading", { name: "다음 문서", exact: true }).waitFor();
    await page.reload();
    await next.getByRole("heading", { name: "다음 문서", exact: true }).waitFor();
    await next.getByRole("button", { name: "Close file", exact: true }).click();
    await page.locator(".chat-view").getByRole("button", { name: "docs/plain.txt", exact: true }).click();
    const plain = page.getByRole("dialog", { name: "plain.txt", exact: true });
    await plain.locator(".file-viewer-text").waitFor();
    assert.equal(await plain.locator(".file-viewer-text").textContent(), markdown);
    assert.equal(await plain.locator(".file-viewer-text").evaluate((node) => parseFloat(getComputedStyle(node).fontSize)), styles.chatFontSize);
    assert.equal(await plain.getByRole("button", { name: "Rendered", exact: true }).count(), 0);
    await plain.getByRole("button", { name: "Close file", exact: true }).click();
    await page.locator(".chat-view").getByRole("button", { name: "docs/large.markdown", exact: true }).click();
    const large = page.getByRole("dialog", { name: "large.markdown", exact: true });
    await large.getByRole("heading", { name: "큰 문서", exact: true }).waitFor();
    await large.getByText(/Showing the first/).waitFor();
    await large.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal((await large.locator(".file-viewer-text").textContent())?.length < 262_144, true);
    assert.deepEqual(errors, []);
    console.log(`PASS app theme, properties, source, safe content, relative links, font and bounded preview: ${width} ${theme}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  await workspaceClose(workspace.workspace.workspace_id);
  rmSync(root, { recursive: true, force: true });
}
