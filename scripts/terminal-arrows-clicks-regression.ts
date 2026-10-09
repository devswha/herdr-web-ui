/** Arrows and clicks reach a full-screen program: browser → WS → herdr → a raw-mode PTY that logs its stdin (#621). */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneRead } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-arrows-clicks-"));
const owned: string[] = [];
const attached = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state-attached"), token: "" });
// a PC without Node for the PTY sidecar: the pane is mirrored, and xterm never learns a mouse mode
const mirrored = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state-mirrored"), token: "", sidecar: false });
let launched: Browser | undefined;
const errors: string[] = [];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const probe = resolve("scripts/fixtures/modifier-probe.py");
/** how long input that must not arrive gets to show up */
const NO_SEND_WAIT_MS = 400;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(20);
  }
}

interface Session {
  page: Page;
  pane: string;
  frames: Array<{ type: string; text?: string; keys?: string[] }>;
  /** what the program in the pane has read since the last call */
  received: () => string;
  /** a point of the grid, in page pixels from its top left corner */
  point: (x: number, y: number) => Promise<{ x: number; y: number }>;
  close: () => Promise<void>;
}

/** A pane of its own running the stdin logger after `modes` were set, shown in a desktop browser. */
async function open(browser: Browser, server: ReturnType<typeof createServer>, name: string, modes: string): Promise<Session> {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const made = await workspaceCreate({ cwd, label: `herdr-web-ui-test-arrows-clicks-${name}` });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const log = join(root, `${name}.hex`);
  await paneSendText(pane, `clear; printf '${modes}'; python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes("PROBE READY plain"), `${name}: raw probe ready`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ pane }) => {
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`herdr-web-ui:view:${pane}`, "terminal");
  }, { pane });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  const frames: Session["frames"] = [];
  let ready = false;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.pane_id === pane && (message.type === "input" || message.type === "keys")) frames.push(message);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "error") console.log(`${name}: terminal error`, message);
      if (message.type === "input-ready" && message.pane_id === pane) ready = message.ready !== false;
    });
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await until(() => ready, `${name}: terminal accepts input`);
  await page.locator(".xterm-screen").waitFor();
  let read = 0;
  return {
    page, pane, frames,
    received: () => {
      const all = existsSync(log) ? readFileSync(log, "utf8") : "";
      const fresh = all.slice(read);
      read = all.length;
      return Buffer.from(fresh, "hex").toString("latin1");
    },
    point: async (x, y) => {
      const box = (await page.locator(".xterm-screen").boundingBox())!;
      return { x: box.x + x, y: box.y + y };
    },
    close: () => context.close(),
  };
}

try {
  const browser = launched = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  // 1. Application cursor keys: less, git log and vim ask for them, and herdr's attach stream
  // never says so to the browser. The program must read SS3 (ESC O A), not CSI (ESC [ A).
  {
    const s = await open(browser, attached, "decckm", "\\033[?1049h\\033[?1h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    for (const [key, final, name] of [["ArrowUp", "A", "up"], ["ArrowDown", "B", "down"], ["ArrowRight", "C", "right"], ["ArrowLeft", "D", "left"]] as const) {
      const before = s.frames.length;
      let got = "";
      await s.page.keyboard.press(key);
      await until(() => (got += s.received()).length >= 3, `decckm ${key} received`);
      assert.equal(got, `\x1bO${final}`, `${key} in application cursor mode`);
      assert.deepEqual(s.frames.slice(before), [{ type: "keys", pane_id: s.pane, keys: [name] }], `${key} is one named key, sent once`);
    }
    if (evidence) await s.page.screenshot({ path: join(evidence, "arrows-decckm.png") });
    await s.close();
  }

  // 2. Normal cursor mode (a shell's line editor), and typing around an arrow keeps its order:
  // the arrow goes through herdr, the letters would otherwise overtake it on the pty.
  {
    const s = await open(browser, attached, "normal", "\\033[?1049h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    let got = "";
    for (let round = 0; round < 5; round += 1) {
      await s.page.keyboard.press("a");
      await s.page.keyboard.press("ArrowLeft");
      await s.page.keyboard.press("b");
    }
    await until(() => (got += s.received()).length >= 25, "letters and arrows received");
    assert.equal(got, "a\x1b[Db".repeat(5), "an arrow between two letters arrives between them");
    // Ctrl+arrow and Shift+arrow were never plain arrows: they keep the path they had
    const before = s.frames.length;
    await s.page.keyboard.press("Control+ArrowLeft");
    await until(() => s.frames.length > before, "Ctrl+ArrowLeft sent");
    assert.deepEqual(s.frames.slice(before), [{ type: "input", pane_id: s.pane, text: "\x1b[1;5D" }]);
    await until(() => (got = s.received()).length >= 6, "Ctrl+ArrowLeft received");
    await s.close();
  }

  // 3. A click reaches a program that reads the mouse; a drag and a modifier-click still select.
  {
    const s = await open(browser, attached, "mouse", "\\033[?1049h\\033[?1000h\\033[?1006h");
    const at = await s.point(100, 70);
    let got = "";
    const click = /\x1b\[<0;(\d+);(\d+)M[\s\S]*\x1b\[<0;(\d+);(\d+)m/;
    await s.page.mouse.click(at.x, at.y);
    await until(() => click.test(got += s.received()), "left click received as press and release");
    const first = click.exec(got)!;
    assert.deepEqual([first[3], first[4]], [first[1], first[2]], "the release is at the press's cell");
    assert.equal((got.match(/\x1b\[<0;\d+;\d+M/g) ?? []).length, 1, "one press for one click");
    assert.equal((got.match(/\x1b\[<0;\d+;\d+m/g) ?? []).length, 1, "one release for one click");
    if (evidence) await s.page.screenshot({ path: join(evidence, "click-mouse-reporting.png") });

    // a drag is a selection, as before: no button report, and the dragged cells are selected
    const to = await s.point(300, 70);
    await s.page.mouse.move(at.x, at.y);
    await s.page.mouse.down();
    await s.page.mouse.move((at.x + to.x) / 2, at.y, { steps: 4 });
    await s.page.mouse.move(to.x, to.y, { steps: 4 });
    await s.page.mouse.up();
    await until(async () => (await s.page.locator(".xterm-selection div").count()) > 0, "a drag selects");
    await Bun.sleep(NO_SEND_WAIT_MS);
    assert.doesNotMatch(s.received(), /\x1b\[<0;/, "a drag sends the program no button");

    // the selection modifier held by the user: a click that asks for selection is not the program's
    await s.page.keyboard.down("Shift");
    await s.page.mouse.click(at.x, at.y);
    await s.page.keyboard.up("Shift");
    await Bun.sleep(NO_SEND_WAIT_MS);
    assert.doesNotMatch(s.received(), /\x1b\[<0;/, "Shift+click sends the program no button");

    // a second click still arrives: the first one left no drag behind
    const second = await s.point(400, 200);
    got = "";
    await s.page.mouse.click(second.x, second.y);
    await until(() => click.test(got += s.received()), "a later click received");
    const later = click.exec(got)!;
    assert.ok(Number(later[1]) > Number(first[1]) && Number(later[2]) > Number(first[2]), "at its own cell, right of and below the first");
    await s.close();
  }

  // 4. A mirrored pane: arrows are named keys there too, and a click sends nothing, since the
  // browser was never told the program reads the mouse and herdr has no pty to report it to.
  {
    const s = await open(browser, mirrored, "mirror", "\\033[?1049h\\033[?1h\\033[?1000h\\033[?1006h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    let got = "";
    await s.page.keyboard.press("ArrowDown");
    await until(() => (got += s.received()).length >= 3, "mirrored ArrowDown received");
    assert.equal(got, "\x1bOB", "a mirrored pane's program reads the arrow in its own mode");
    const before = s.frames.length;
    const box = await s.page.locator(".xterm-screen").boundingBox();
    await s.page.mouse.click(box!.x + 80, box!.y + 60);
    await Bun.sleep(NO_SEND_WAIT_MS);
    assert.deepEqual(s.frames.slice(before), [], "a click on a mirrored pane sends nothing");
    assert.equal(s.received(), "", "and the program reads nothing");
    await s.close();
  }

  assert.deepEqual(errors, [], "no page errors");
  console.log("terminal arrows and clicks: PASS");
} finally {
  await launched?.close();
  await attached.stop();
  await mirrored.stop();
  for (const id of owned) await workspaceClose(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
