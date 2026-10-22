import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { AgentKind } from "../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../shared/supported-agents.ts";
import panes from "../site/demo/fixtures/panes.json";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Usage: UI_EVIDENCE_DIR=<dir> bun scripts/service-agent-path-demo-regression.ts
//
// The New workspace and New tab agent pickers offer exactly the agents GET /api/agents says the PC
// has installed. Which those are is the bridge's business (server/shell-agent.ts reads its login
// shell's PATH; server/api.contract.test.ts proves that on a fixture): this demo runs no login
// shell. In front of the committed demo transport, the page's /api/agents is answered from a
// test-owned installed set, and each state is a request the fixture holds or answers: a held
// answer (loading), a refusal (discovery error), a device that may only watch, a PC that is
// offline. No agent turn is sent, so the demo's timed turn completion never runs. Every state is
// captured at 1440 and on a 390 phone (DPR 3, touch) in both themes, with Korean at 390, as
// agent-picker-<width>-<theme>[-ko]-<state>.png under UI_EVIDENCE_DIR (or evidence/), with
// manifest.json and measurements.json beside them. All traffic stays in this loopback-only app.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-service-agent-path-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR || join(repo, "evidence", "service-agent-path");
mkdirSync(evidence, { recursive: true });
const TARGET = panes.hermes;

const installed = (kind: string, label: string): AgentKind => ({ kind, label, installed: true });
/** what a service bridge answers once its login PATH found gjc and omo: the rest it reports missing */
const FIXTURE: AgentKind[] = [
  { kind: "claude", label: "Claude Code", installed: false },
  { kind: "codex", label: "Codex", installed: false },
  installed("gjc", "Gajae Code"),
  installed("omp", "Oh My Pi"),
  installed("omo", "OmO"),
];
const OFFERED = ["Shell", "Gajae Code", "Oh My Pi", "OmO"];
const LONG: AgentKind[] = [
  installed("gjc", "Gajae Code"),
  installed("hermes", "Hermes research build with a display name long enough to wrap twice"),
  installed("devin", "DevinCommandLineInterfaceNightlyBuildWithoutAnySpacesAtAll"),
];
const EVERY: AgentKind[] = [...SUPPORTED_AGENT_KINDS].sort().map((kind) => installed(kind, kind));

interface AgentsCase {
  agents: AgentKind[] | "error";
  holdAgents?: boolean;
  holdCreate?: boolean;
  watch?: boolean;
  offline?: boolean;
  theme: "light" | "dark";
  language: "en" | "ko";
}

type Shot = { file: string; width: number; height: number; theme: string; language: string; state: string; sha256: string; capturedAt: string };
const shots: Shot[] = [];
const measurements: Record<string, unknown>[] = [];
const failures: string[] = [];

const pngSize = (bytes: Buffer): { width: number; height: number } => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // In front of the demo's own fetch: /api/agents, health, create and the PC list, as the case says.
  const patch = `<script>(() => {
    const demo = window.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const held = { agents: [], create: [] };
    window.agentsAnswered = 0;
    window.release = (what) => { for (const go of held[what].splice(0)) go(); };
    window.holding = (what) => held[what].length;
    const STUDIO = { id: "studio", name: "studio", kind: "ssh", target: { destination: "studio.example" }, enabled: true, state: "disconnected", error: "connection refused", snapshot: null };
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = parse.call(JSON, text, reviver);
      if (window.agentsCase?.offline && value && Array.isArray(value.machines) && !value.machines.some((machine) => machine.id === "studio")) value.machines.push({ ...STUDIO });
      return value;
    };
    window.fetch = async (input, init) => {
      const c = window.agentsCase;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (c && url.pathname === "/api/agents") {
        if (c.holdAgents) await new Promise((go) => held.agents.push(go));
        window.agentsAnswered += 1;
        return c.agents === "error" ? json({ error: { code: "connect_failed", message: "cannot reach herdr" } }, 502) : json({ agents: c.agents });
      }
      if (c?.watch && url.pathname === "/api/health") {
        const body = await (await demo(input, init)).json();
        body.auth = { ...body.auth, role: "watch" };
        return json(body);
      }
      const create = method === "POST" && (url.pathname === "/api/workspace/create" || url.pathname === "/api/tab/create");
      // the real server's refusal of a device that may only watch (server/index.ts watch-refusal)
      if (c?.watch && create) return json({ error: { code: "read_only", message: "this device can only watch" } }, 403);
      if (c?.holdCreate && create) await new Promise((go) => held.create.push(go));
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, (tag) => `<script src="./demo-transport.js"></script>\n    ${patch}\n    ${tag}`));

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
  const root = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  const workspaceUrl = `${root}?pane=${encodeURIComponent(TARGET)}&new=workspace`;
  const tabUrl = `${root}?ws=${encodeURIComponent(TARGET.split(":")[0]!)}&pane=${encodeURIComponent(TARGET)}&new=tab`;

  const browser: Browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    /** One state in a fresh page: `run` drives it and says when to capture. */
    const scenario = async (width: 1440 | 390, agentsCase: AgentsCase, state: string, url: string, run: (page: Page, capture: () => Promise<void>) => Promise<void>): Promise<void> => {
      const phone = width === 390;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone,
        colorScheme: agentsCase.theme, reducedMotion: "reduce", locale: agentsCase.language === "ko" ? "ko-KR" : "en-US",
      });
      const name = `agent-picker-${width}-${agentsCase.theme}${agentsCase.language === "ko" ? "-ko" : ""}-${state}.png`;
      const errors: string[] = [];
      try {
        await context.addInitScript((c) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: c.language, theme: c.theme }));
          Object.assign(window, { agentsCase: c });
        }, agentsCase);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await appFaces(page, agentsCase.language === "ko" ? "가나" : "Mg");
        await run(page, async () => {
          const file = join(evidence, name);
          await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          const bytes = readFileSync(file);
          shots.push({ file: name, ...pngSize(bytes), theme: agentsCase.theme, language: agentsCase.language, state, sha256: createHash("sha256").update(bytes).digest("hex"), capturedAt: new Date().toISOString() });
        });
        // no horizontal page scroll at any state
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
        assert.deepEqual(errors, [], "no page errors");
        console.log(`PASS ${name}`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await context.close();
      }
    };

    // by its class, not its title: the Korean captures name it in Korean
    const dialogOf = (page: Page) => page.locator(".new-session-modal[role=dialog]");
    /** the picker's rows, once the dialog has the answer it is waiting for */
    const optionLabels = (page: Page) => page.locator(".agent-picker-menu [role=option] .menu-item-main").allTextContents();
    const answered = (page: Page, count = 1) => page.waitForFunction((n) => (window as unknown as { agentsAnswered: number }).agentsAnswered >= n, count, { timeout: 10_000 });
    const settled = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const openPicker = async (page: Page): Promise<void> => {
      await dialogOf(page).locator(".agent-picker-trigger").click();
      await page.locator(".agent-picker-menu").waitFor();
      await settled(page);
    };
    const fillDirectory = (page: Page) => dialogOf(page).locator("#new-session-cwd").fill("~/projects/app");

    /** colour contrast of an element's text against the first opaque background behind it */
    const contrastOf = (page: Page, selector: string) => page.evaluate((sel) => {
      const element = document.querySelector(sel);
      if (!element) return null;
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const c = [r!, g!, b!].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      };
      let node: Element | null = element;
      let background = [255, 255, 255];
      while (node) {
        const parts = rgb(getComputedStyle(node).backgroundColor);
        if (parts.length >= 3 && (parts[3] ?? 1) >= 1) { background = parts.slice(0, 3); break; }
        node = node.parentElement;
      }
      const fg = lum(rgb(getComputedStyle(element).color));
      const bg = lum(background);
      return Math.round(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)) * 100) / 100;
    }, selector);

    for (const width of [1440, 390] as const) for (const theme of ["light", "dark"] as const) {
      const base = { agents: FIXTURE, theme, language: "en" } satisfies AgentsCase;

      await scenario(width, base, "rest", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await settled(page);
        assert.equal(await dialogOf(page).locator(".agent-picker-label").textContent(), "Shell");
        await capture();
      });

      await scenario(width, base, "installed", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await openPicker(page);
        // only what the PC reports installed: claude and codex are missing on it
        assert.deepEqual(await optionLabels(page), OFFERED);
        const trigger = await dialogOf(page).locator(".agent-picker-trigger").boundingBox();
        const rows = await page.locator(".agent-picker-menu [role=option]").evaluateAll((options) => options.map((option) => option.getBoundingClientRect().height));
        measurements.push({ width, theme, state: "installed", trigger_height_css: trigger?.height, min_option_height_css: Math.min(...rows), option_text_contrast: await contrastOf(page, ".agent-picker-menu [role=option]:not([aria-selected=true]) .menu-item-main"), selected_option_text_contrast: await contrastOf(page, ".agent-picker-menu [role=option][aria-selected=true] .menu-item-main") });
        if (width === 390) {
          assert.ok((trigger?.height ?? 0) >= 44, `the trigger is ${trigger?.height}px tall`);
          assert.ok(Math.min(...rows) >= 44, `a row is ${Math.min(...rows)}px tall`);
        }
        await capture();
      });

      await scenario(width, base, "focused", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        const trigger = dialogOf(page).locator(".agent-picker-trigger");
        // keyboard modality: away and back, so the ring is the focus-visible one
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.ok(await trigger.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), "the trigger has keyboard focus");
        await page.keyboard.press("ArrowDown");
        await page.locator(".agent-picker-menu").waitFor();
        await page.keyboard.press("ArrowDown");
        await page.locator(".agent-picker-menu [role=option][data-active]").filter({ hasText: "Gajae Code" }).waitFor();
        await settled(page);
        measurements.push({ width, theme, state: "focused", trigger_focus: await trigger.evaluate((node) => { const style = getComputedStyle(node); return { outline: `${style.outlineStyle} ${style.outlineWidth}`, boxShadow: style.boxShadow, border: `${style.borderTopWidth} ${style.borderTopColor}` }; }), trigger_rest_border: await dialogOf(page).locator("#new-session-cwd").evaluate((node) => { const style = getComputedStyle(node); return `${style.borderTopWidth} ${style.borderTopColor}`; }) });
        await capture();
      });

      if (width === 1440) await scenario(width, base, "hover", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await openPicker(page);
        await page.locator(".agent-picker-menu [role=option]").filter({ hasText: "Oh My Pi" }).hover();
        await settled(page);
        await capture();
      });

      await scenario(width, base, "pressed", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await openPicker(page);
        const box = await page.locator(".agent-picker-menu [role=option]").filter({ hasText: "OmO" }).boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await settled(page);
        await capture();
        await page.mouse.up();
        await dialogOf(page).locator(".agent-picker-label", { hasText: "OmO" }).waitFor();
      });

      await scenario(width, { ...base, holdCreate: true }, "disabled", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await fillDirectory(page);
        await dialogOf(page).locator("button[type=submit]").click();
        await page.waitForFunction(() => (window as unknown as { holding: (what: string) => number }).holding("create") === 1, undefined, { timeout: 10_000 });
        await dialogOf(page).locator(".agent-picker-trigger:disabled").waitFor();
        await settled(page);
        await capture();
        await page.evaluate(() => (window as unknown as { release: (what: string) => void }).release("create"));
        await dialogOf(page).waitFor({ state: "hidden" });
      });

      await scenario(width, { ...base, agents: FIXTURE.map((agent) => ({ ...agent, installed: false })) }, "empty", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await openPicker(page);
        assert.deepEqual(await optionLabels(page), ["Shell"]);
        await capture();
      });

      await scenario(width, { ...base, holdAgents: true }, "loading", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await page.waitForFunction(() => (window as unknown as { holding: (what: string) => number }).holding("agents") === 1, undefined, { timeout: 10_000 });
        await openPicker(page);
        // nothing is offered before the PC answers but the shell
        assert.deepEqual(await optionLabels(page), ["Shell"]);
        await capture();
        await page.evaluate(() => (window as unknown as { release: (what: string) => void }).release("agents"));
        await page.locator(".agent-picker-menu [role=option]").filter({ hasText: "Gajae Code" }).waitFor();
        assert.deepEqual(await optionLabels(page), OFFERED);
      });

      await scenario(width, { ...base, agents: "error" }, "error", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await dialogOf(page).getByRole("alert").first().waitFor();
        await openPicker(page);
        // a discovery that failed offers nothing it was not told
        assert.deepEqual(await optionLabels(page), ["Shell"]);
        await page.keyboard.press("Escape");
        await page.locator(".agent-picker-menu").waitFor({ state: "hidden" });
        await settled(page);
        await capture();
      });

      await scenario(width, { ...base, agents: LONG }, "long", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await openPicker(page);
        assert.deepEqual(await optionLabels(page), ["Shell", ...LONG.map((agent) => agent.label)]);
        const spill = await page.locator(".agent-picker-menu").evaluate((menu) => menu.scrollWidth - menu.clientWidth);
        assert.ok(spill <= 0, `the list scrolls sideways by ${spill}px`);
        await capture();
      });

      await scenario(width, { ...base, agents: EVERY }, "scrolled-end", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        await dialogOf(page).locator(".agent-picker-trigger").focus();
        await page.keyboard.press("ArrowDown");
        await page.locator(".agent-picker-menu").waitFor();
        await page.keyboard.press("End");
        const last = page.locator(".agent-picker-menu [role=option]").last();
        await last.and(page.locator("[data-active]")).waitFor();
        // the list scrolls, and has scrolled so its last row is wholly in view
        await page.waitForFunction(() => {
          const menu = document.querySelector(".agent-picker-menu");
          const row = menu?.querySelector("[role=option]:last-child");
          if (!menu || !row || menu.scrollHeight <= menu.clientHeight || menu.scrollTop === 0) return false;
          const outer = menu.getBoundingClientRect(), inner = row.getBoundingClientRect();
          return inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
        }, undefined, { timeout: 5000 });
        await settled(page);
        await capture();
      });

      await scenario(width, { ...base, watch: true }, "observe", workspaceUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        await answered(page);
        // a device that may only watch reads what is offered, and its start is refused by the PC
        await openPicker(page);
        assert.deepEqual(await optionLabels(page), OFFERED);
        await page.keyboard.press("Escape");
        await fillDirectory(page);
        await dialogOf(page).locator("button[type=submit]").click();
        await dialogOf(page).getByRole("alert").first().waitFor();
        await settled(page);
        await capture();
      });

      await scenario(width, { ...base, offline: true }, "offline", root + `?pane=${encodeURIComponent(TARGET)}`, async (page, capture) => {
        if (width === 390) await page.locator(".drawer-toggle").tap();
        const studio = page.getByRole("button", { name: "New workspace on studio", exact: true });
        await studio.waitFor();
        // an offline PC is not asked: its New workspace stays disabled
        assert.ok(await studio.isDisabled(), "an offline PC's New workspace is disabled");
        assert.equal(await page.evaluate(() => (window as unknown as { agentsAnswered: number }).agentsAnswered), 0, "no discovery is read for it");
        await settled(page);
        await capture();
      });

      await scenario(width, base, "newtab", tabUrl, async (page, capture) => {
        await dialogOf(page).waitFor();
        assert.match(await dialogOf(page).locator(".modal-title").textContent() ?? "", /^New tab · /);
        await answered(page);
        await openPicker(page);
        assert.deepEqual(await optionLabels(page), OFFERED);
        await capture();
      });

      if (width === 390) {
        const ko = { ...base, language: "ko" } satisfies AgentsCase;
        await scenario(width, ko, "installed", workspaceUrl, async (page, capture) => {
          await dialogOf(page).waitFor();
          await answered(page);
          await openPicker(page);
          assert.deepEqual(await optionLabels(page), OFFERED);
          await capture();
        });
        await scenario(width, { ...ko, agents: "error" }, "error", workspaceUrl, async (page, capture) => {
          await dialogOf(page).waitFor();
          await answered(page);
          await dialogOf(page).getByRole("alert").first().waitFor();
          await settled(page);
          await capture();
        });
        await scenario(width, { ...ko, watch: true }, "observe", workspaceUrl, async (page, capture) => {
          await dialogOf(page).waitFor();
          await answered(page);
          await fillDirectory(page);
          await dialogOf(page).locator("button[type=submit]").click();
          await dialogOf(page).getByRole("alert").first().waitFor();
          await settled(page);
          await capture();
        });
        await scenario(width, { ...ko, offline: true }, "offline", root + `?pane=${encodeURIComponent(TARGET)}`, async (page, capture) => {
          await page.locator(".drawer-toggle").tap();
          await page.locator(".machine-new[disabled]").first().waitFor();
          await settled(page);
          await capture();
        });
        await scenario(width, ko, "newtab", tabUrl, async (page, capture) => {
          await dialogOf(page).waitFor();
          await answered(page);
          await openPicker(page);
          assert.deepEqual(await optionLabels(page), OFFERED);
          await capture();
        });
      }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}

writeFileSync(join(evidence, "manifest.json"), JSON.stringify({ files: shots }, null, 2) + "\n");
writeFileSync(join(evidence, "measurements.json"), JSON.stringify(measurements, null, 2) + "\n");
console.log(failures.length === 0
  ? `PASS agent picker states: ${shots.length} screenshots in ${evidence}`
  : `FAIL ${failures.length} state(s):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
if (failures.length > 0) process.exitCode = 1;
