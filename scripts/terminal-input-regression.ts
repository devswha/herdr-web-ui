/** Input lifecycle adversarial cases, using an owned pane and intercepted submits. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { openSettingsPage } from "./settings-page.ts";

export async function checkTerminalInput(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript(() => {
    if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
  });
  const sent: any[] = [];
  let acknowledge: (() => void) | undefined;
  let ready: (() => void) | undefined;
  let delayReady = false;
  let refuse = false;
  let current: { close: () => Promise<void> } | undefined;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (refuse) { void socket.close(); return; }
    current = socket;
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (delayReady && frame.type === "input-ready") ready = () => socket.send(raw);
      else socket.send(raw);
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "submit") {
        sent.push(frame);
        acknowledge = () => socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: true }));
      } else if (frame.type === "input") sent.push(frame);
      else server.send(raw);
    });
  });
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  // A desktop has no key bar: the input mode is a Settings choice there.
  const setMode = async (mode: "line" | "direct") => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    await page.getByRole("combobox", { name: "Terminal input mode", exact: true }).selectOption(mode);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  const remountLine = async () => { await setMode("direct"); await setMode("line"); };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, "input regression timed out"); await new Promise((r) => setTimeout(r, 25)); }
  };
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await page.locator(".key-bar").isVisible(), false, "a desktop shows no key bar under the terminal");
    assert.equal(await page.getByRole("button", { name: "Type straight into the terminal", exact: true }).count(), 0);
    await line.fill("draft 한글 😀");
    await remountLine();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.reload();
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.goto(`${origin}/?pane=${encodeURIComponent(otherPane)}`);
    if (!(await line.isVisible())) await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await line.inputValue(), "");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");

    const note = page.locator(".terminal-input-note");
    const noteText = async () => (await note.count()) === 0 ? null : await note.textContent();
    const sendButton = page.getByRole("button", { name: "Send to the terminal", exact: true });
    // A real composition (Chrome's IME path, as Gboard composes every word): the Send keeps focus,
    // so the tap itself must finish the word, and it sends the committed line at once.
    await line.fill("real 한");
    await line.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "글", selectionStart: 1, selectionEnd: 1 });
    await until(async () => (await line.inputValue()) === "real 한글");
    await sendButton.click();
    await until(async () => sent.length === 1 || (await noteText()) === "Finish the word, then send.");
    assert.equal(sent.length, 1, "a Send during a real composition finishes the word and sends");
    assert.equal(sent[0].text, "real 한글");
    assert.equal(await line.evaluate((element) => element === document.activeElement), true, "the line keeps focus, so the keyboard stays up");
    await cdp.detach();
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // A keyboard that commits on its own within the wait: the line as committed is sent, once,
    // even when the committing input lands in the same task as compositionend.
    await line.fill("commit 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    assert.equal(sent.length, 1, "unfinished composition must not submit via button");
    await line.evaluate((element: HTMLTextAreaElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "글" }));
      setValue.call(element, "commit 한글");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "글", inputType: "insertFromComposition" }));
    });
    await until(() => sent.length === 2);
    assert.equal(sent[1].text, "commit 한글", "the Send tapped during composition sends the committed line");
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // The terminal drops while the word is still being finished: the commit says so instead of
    // leaving "Finishing the word…" up for good.
    await line.fill("offline 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    refuse = true;
    await current!.close();
    await until(() => sendButton.isDisabled());
    await line.dispatchEvent("compositionend", { data: "한" });
    await until(async () => (await noteText()) !== "Finishing the word…");
    assert.equal(await note.textContent(), "Not sent: the terminal is disconnected.");
    assert.equal(sent.length, 2);
    refuse = false;
    await until(async () => !(await sendButton.isDisabled()));
    // No commit within the wait: the tap is withdrawn with a note, and a later commit sends nothing.
    await line.fill("draft 한글 😀");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finish the word, then send.");
    await line.dispatchEvent("compositionend", { data: "😀" });
    // past a deferred send's tick and a whole commit window
    await page.waitForTimeout(400);
    assert.equal(sent.length, 2, "a commit after the withdrawn tap does not send");
    assert.equal(await note.textContent(), "Finish the word, then send.");
    await line.dispatchEvent("compositionstart", { data: "" });
    // Leaving during composition must not leave the composition guard stuck.
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await remountLine();
    await line.waitFor();
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => !!acknowledge);
    await remountLine();
    assert.equal(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled(), true, "pending send survives remount");
    await line.fill("");
    await line.fill("draft 한글 😀");
    acknowledge!();
    await until(async () => !(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled()));
    assert.equal(await line.inputValue(), "draft 한글 😀", "late ack cannot erase replacement text");
    assert.equal(sent.length, 3);

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    const shortcut = page.getByRole("combobox", { name: "Command palette", exact: true });
    await shortcut.selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await shortcut.selectOption("off");
    await page.getByRole("combobox", { name: "Next pane", exact: true }).selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await line.focus();
    const selectionBefore = await page.evaluate(() => localStorage.getItem("herdr-web-ui:selection"));
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await until(async () => (await page.evaluate(() => localStorage.getItem("herdr-web-ui:selection"))) !== selectionBefore);
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await page.getByRole("button", { name: "Reset shortcuts", exact: true }).click();
    if (process.env.UI_EVIDENCE_DIR) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await shortcut.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-phone.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "settings must fit phone width");
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // A screen can arrive before attachment readiness; do not send or auto-replay typing.
    delayReady = true;
    await setMode("direct");
    await page.reload();
    await page.locator(".xterm-helper-textarea").waitFor();
    await until(() => !!ready);
    const before = sent.length;
    await page.locator(".xterm-helper-textarea").press("a");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a");
    assert.equal(sent.length, before);
    // Exactly the first held character must survive reload, not merely later edits.
    ready = undefined;
    await page.reload();
    await page.locator(".draft-text").waitFor();
    assert.equal(await page.locator(".draft-text").textContent(), "a");
    await until(() => !!ready);
    ready!();
    await page.waitForTimeout(150);
    assert.equal(sent.length, before, "ready does not replay the draft");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await until(() => sent.length > before);
    assert.equal(sent.at(-1).text, "a");
    // Real xterm handling: an IME's provisional syllable stays local until commit.
    const imeBefore = sent.length;
    const input = page.locator(".xterm-helper-textarea");
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(50);
    assert.equal(sent.length, imeBefore);
    await input.dispatchEvent("compositionend", { data: "한" });
    await until(() => sent.length > imeBefore);
    assert.equal(sent.slice(imeBefore).map((frame) => frame.text).join(""), "한");
    // Native Gboard emits Backspace while xterm retains the previous DOM text. The
    // next IME session must start with a fresh scratch editor, not that stale context.
    await input.evaluate((element) => { const box = element as HTMLTextAreaElement; box.value = "가나다 "; box.setSelectionRange(4, 4); });
    const deletionBefore = sent.length;
    await input.press("Backspace");
    assert.equal(await input.inputValue(), "", "non-composing Backspace resets stale IME context");
    assert.equal(sent.slice(deletionBefore).map((frame) => frame.text).join(""), "\x7f");
    const burstBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "니" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "니" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니다";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "다" }));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "다" }));
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", code: "Period", keyCode: 190, which: 190 }));
    });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(burstBefore).map((frame) => frame.text).join(""), "니다.", "queued compositions must drain before punctuation (#6089)");

    const movedBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "핫";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "핫" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      // The IME's event can report 핫 even though its final consonant moved to 세.
      box.value = "하";
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "핫" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "하세";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "세" }));
    });
    await page.waitForTimeout(25);
    await input.dispatchEvent("compositionend", { data: "세" });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(movedBefore).map((frame) => frame.text).join(""), "하세", "read corrected DOM text, not stale compositionend.data");
    const switchBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(25);
    await page.evaluate((target) => {
      const box = document.querySelector(".xterm-helper-textarea")!;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
      const row = [...document.querySelectorAll<HTMLElement>(".pane-select")].find((row) => row.title.startsWith(target + " —"));
      if (!row) throw new Error("owned destination pane missing");
      row.click();
    }, otherPane);
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:selection")!).pane_id)) === otherPane);
    await page.waitForTimeout(75);
    assert.equal(sent.length, switchBefore, "old composition cannot cross a pane reset");
    assert.equal(await page.locator(".draft-text").count(), 0, "old commit cannot enter the new pane's held draft");
    // A late end after reset is stale, not a second attempt to send the abandoned input.
    await page.locator(".xterm-helper-textarea").dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(75);
    assert.equal(sent.length, switchBefore);
    console.log("PASS xterm composition: local preedit, delayed multi-commit burst, punctuation order, Korean final-consonant movement, pane-reset cancellation");
    assert.deepEqual(errors, []);
    console.log("PASS terminal input: desktop mode, owner drafts, reload, IME button, late ack, shortcuts, readiness, explicit send");
  } finally { await context.close(); }
}


if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-input-qa-"));
  const owned: string[] = [];
  const server = createServer({ port: 0, stateDir: root, token: "" });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-input" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkTerminalInput(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser.close(); server.stop();
    for (const id of owned) await workspaceClose(id);
    rmSync(root, { recursive: true, force: true });
  }
}
