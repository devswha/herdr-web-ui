/**
 * Mod+Shift+A, the next agent needing attention (lib/attentionJump.ts), on the real client over the
 * demo's fixture transport with two PCs that reuse every herdr id: the order (the pinned card first,
 * then blocked, then finishes not looked at, as the Agents list draws them), the wrap, a finish
 * opened here dropping out through the shared seen record, a PC away mid-cycle, no attention at all,
 * a composing chord, and that nothing but this browser's selection moves (no pane.focus, take-over or
 * input on the wire). With UI_EVIDENCE_DIR set it also captures the selected row, the palette action
 * and the Settings row at a phone's and a desktop's width in both themes (and Korean at 390), with a
 * manifest. Everything stays in this disposable, loopback-only app; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";
import type { Machine, MachineState } from "../shared/machines.ts";
import type { AgentStatus, ConversationResponse } from "../shared/protocol.ts";

type Forced = [machineId: string, paneId: string, status: AgentStatus, seq: number];
interface WireCalls { ws: { machine: string; type: string; pane_id?: string; mode?: string }[]; posts: { machine: string; method: string; path: string }[]; acks: { machine: string; mode: string }[] }

declare global {
  interface Window {
    attentionFixture: {
      /** force each pane's status on its PC; "done" with a new seq is a new finish, on HTTP rosters and pushed statuses alike */
      set(forced: Forced[]): Promise<void>;
      /** the remote PC's connection state; its saved roster stays, as a PC away keeps it */
      remote(state: MachineState): Promise<void>;
      /** a conversation read of this PC's pane waits until release(): its finish cannot be looked at */
      hold(machineId: string, paneId: string): void;
      release(): void;
      label(machineId: string, paneId: string, label: string): Promise<void>;
      calls: WireCalls;
    };
  }
}

// Two PCs over the demo's one: the remote is the local roster again under another name and
// state, so every pane id exists on both. Test-owned statuses survive a reload in sessionStorage;
// the app and its storage code stay unmodified. Only SSE rosters and pushed pane statuses carry
// the fixture's finish epoch, so the finishes looked at here keep their records across reloads.
function installAttentionFixture(): void {
  const KEY = "attention-regression:state";
  const stored = sessionStorage.getItem(KEY);
  const state: { statuses: Record<string, Record<string, { status: AgentStatus; seq: number }>>; labels: Record<string, Record<string, string>>; remote: MachineState } =
    stored ? JSON.parse(stored) : { statuses: {}, labels: {}, remote: "connected" };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  const epoch = (id: string) => `attention-fixture:${id}:1`;
  const sources = new Set<EventSource>();
  const held = new Set<string>();
  const pending: (() => void)[] = [];
  const calls: WireCalls = { ws: [], posts: [], acks: [] };
  // a device paired to watch (?observe): the server demotes each of its connections to observe, on
  // every PC, whatever role the page asks for, and its role-ack says so (shared/protocol.ts "Roles")
  const observe = new URLSearchParams(location.search).has("observe");
  let demoMachines: Machine[] = [];
  const roster = (): Machine[] => ["local", "remote"].map((id) => {
    const machine = structuredClone(demoMachines.find((item) => item.id === "local")!);
    machine.id = id;
    machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Build PC";
    if (id === "remote") { machine.target = { destination: "build.invalid" }; machine.state = state.remote; machine.herdr = { version: "0.9.0", protocol: 22, terminal_attach: true }; }
    const snapshot = machine.snapshot!;
    snapshot.finish_epoch = epoch(id);
    for (const pane of snapshot.panes) {
      const forced = state.statuses[id]?.[pane.pane_id];
      if (forced) { pane.agent_status = forced.status; pane.finish_id = forced.seq; }
      const label = state.labels[id]?.[pane.pane_id];
      if (label !== undefined) pane.label = label;
    }
    for (const agent of snapshot.agents) {
      const forced = state.statuses[id]?.[agent.pane_id];
      if (forced) { agent.agent_status = forced.status; agent.state_change_seq = forced.seq; }
    }
    return machine;
  });
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.startsWith("/api/")) return fetchDemo(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const match = /^\/api\/machines\/([^/]+)(\/.*)$/.exec(url.pathname);
    const machine = match ? decodeURIComponent(match[1]!) : "local";
    const path = match ? `/api${match[2]}` : url.pathname;
    if (method !== "GET" && method !== "HEAD") calls.posts.push({ machine, method, path });
    if (path === "/api/machines" && !match) {
      const body = await (await fetchDemo(input, init)).json();
      demoMachines = body.machines;
      return Response.json({ ...body, machines: roster() });
    }
    if (match && path === "/api/session") return Response.json({ snapshot: roster().find((item) => item.id === machine)!.snapshot });
    const paneId = url.searchParams.get("pane_id") ?? "";
    if (path === "/api/pane/conversation" && held.has(`${machine}:${paneId}`)) await new Promise<void>((resolve) => pending.push(resolve));
    const response = await fetchDemo(match ? `${path}${url.search}` : input, init);
    if (path === "/api/health" && new URLSearchParams(location.search).has("observe") && response.ok) {
      const body = await response.json();
      return Response.json({ ...body, auth: { ...body.auth, role: "watch" } });
    }
    const forced = state.statuses[machine]?.[paneId];
    if (path === "/api/pane/conversation" && response.ok && forced?.status === "done") {
      // a forced finish is a completed answer of its own, dated after the one before it, as a real one is
      const body = await response.json() as ConversationResponse;
      const last = body.turns.at(-1);
      if (last?.role === "assistant") {
        last.ts = new Date((Date.parse(last.ts ?? "") || 0) + forced.seq * 1000).toISOString();
        if (last.end_ts) last.end_ts = new Date(Date.parse(last.end_ts) + forced.seq * 1000).toISOString();
      }
      return Response.json(body);
    }
    return response;
  }, fetchDemo);
  const DemoSocket = window.WebSocket;
  window.WebSocket = class extends DemoSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const machine = new URL(String(url), location.href).searchParams.get("machine_id") ?? "local";
      // the demo constructor returns its own object: its send is wrapped on that instance
      const send = this.send.bind(this);
      this.send = (raw) => {
        const message = JSON.parse(String(raw));
        calls.ws.push({ machine, type: message.type, pane_id: message.pane_id, ...(message.type === "role" ? { mode: message.mode } : {}) });
        send(observe && message.type === "role" ? JSON.stringify({ ...message, mode: "observe" }) : raw);
      };
      // the role each socket was acknowledged in: the demo socket answers its role frame with role-ack
      this.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data));
        if (message.type === "role-ack") calls.acks.push({ machine, mode: message.mode });
      });
    }
  };
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
      let receive: EventSource["onmessage"] = null;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          const body = JSON.parse(event.data);
          if (body.type === "machines") { demoMachines = body.machines; body.machines = roster(); }
          if (body.type === "machine-message" && body.message.type === "pane-status") {
            body.message.finish_epoch = epoch(body.machine_id);
            const forced = state.statuses[body.machine_id]?.[body.message.pane_id];
            if (forced) { body.message.agent_status = forced.status; body.message.finish_id = forced.seq; }
          }
          receive?.call(this, new MessageEvent("message", { data: JSON.stringify(body) }));
        },
        set: (handler: EventSource["onmessage"]) => { receive = handler; },
      });
    }
    close(): void { sources.delete(this); super.close(); }
  };
  const publish = async (): Promise<void> => {
    save();
    const { machines } = await (await fetch("/api/machines")).json();
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines }) }));
  };
  window.attentionFixture = {
    calls,
    async set(forced) {
      for (const [machineId, paneId, status, seq] of forced) (state.statuses[machineId] ??= {})[paneId] = { status, seq };
      await publish();
    },
    async remote(remote) { state.remote = remote; await publish(); },
    hold(machineId, paneId) { held.add(`${machineId}:${paneId}`); },
    release() { held.clear(); for (const resolve of pending.splice(0)) resolve(); },
    async label(machineId, paneId, label) { (state.labels[machineId] ??= {})[paneId] = label; await publish(); },
  };
}

const app = mkdtempSync(join(tmpdir(), "herdr-attention-jump-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });

const AGENT_PANES = [panes.api, panes.web, panes.flaky, panes.omp, panes.cli, panes.hermes];
const FORBIDDEN_FRAMES = new Set(["take-over", "input", "keys", "submit", "pending-action", "secret"]);
const FORBIDDEN_POST = /\/pane\/(?:focus|input|keys|prompt|take)/;
const target = (machine: string, pane: string) => `${machine}/${pane}`;

/** every agent of both PCs at rest, then the given ones as asked */
const quiet = (...forced: Forced[]): Forced[] => [
  ...(["local", "remote"] as const).flatMap((machine) => AGENT_PANES.map((pane): Forced => [machine, pane, "idle", 1])),
  ...forced,
];
const setStatuses = (page: Page, forced: Forced[]) => page.evaluate((list) => window.attentionFixture.set(list), forced);
const selection = (page: Page) => page.evaluate(() => {
  const stored = JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null") as { machine_id?: string; pane_id?: string | null } | null;
  return stored?.pane_id ? `${stored.machine_id}/${stored.pane_id}` : null;
});
const waitSelected = (page: Page, machine: string, pane: string) => page.waitForFunction(([machineId, paneId]) => {
  const stored = JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "null") as { machine_id?: string; pane_id?: string | null } | null;
  const row = document.querySelector(".agents-sidebar .agent-item.is-selected");
  return stored?.machine_id === machineId && stored?.pane_id === paneId && row?.getAttribute("data-machine") === machineId && row.getAttribute("data-pane") === paneId;
}, [machine, pane] as const, { timeout: 10_000 });
const waitStatus = (page: Page, machine: string, pane: string, status: string) =>
  page.locator(`.agents-sidebar .agent-item[data-machine="${machine}"][data-pane="${pane}"] .sidebar-status[data-status="${status}"]`).waitFor({ state: "attached", timeout: 10_000 });
const wireCalls = (page: Page) => page.evaluate(() => window.attentionFixture.calls);
/** the chord of this page's platform: Meta on an Apple platform, Ctrl elsewhere, as the app reads it */
const chord = async (page: Page) => (await page.evaluate(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent))) ? "Meta+Shift+A" : "Control+Shift+A";
/** this PC's socket acknowledged as an observer (its last role-ack), and the open pane drawn view-only */
const waitObserver = (page: Page, machine: string) => page.waitForFunction((machineId) => {
  const acks = window.attentionFixture.calls.acks.filter((ack) => ack.machine === machineId);
  return acks.length > 0 && acks.at(-1)!.mode === "observe" && document.querySelector(".pane-frame.is-current .terminal-banner-observe") !== null;
}, machine, { timeout: 10_000 });
/** one press, and the selection it leaves: written at once by the handler, so a no-op reads as the same value */
async function press(page: Page, keys: string): Promise<string | null> {
  await page.keyboard.press(keys);
  return selection(page);
}
/** the chord held down: the first keydown jumps, and each further keydown of the held key is a key repeat (repeat: true) */
async function hold(page: Page, keys: string, repeats: number): Promise<string | null> {
  const modifiers = keys.split("+");
  const key = modifiers.pop()!;
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.down(key);
  for (let index = 0; index < repeats; index += 1) await page.keyboard.down(key);
  const held = await selection(page);
  await page.keyboard.up(key);
  for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier);
  return held;
}
async function assertSelectionOnly(page: Page, since: WireCalls, what: string): Promise<WireCalls> {
  const calls = await wireCalls(page);
  const frames = calls.ws.slice(since.ws.length);
  const posts = calls.posts.slice(since.posts.length);
  assert.deepEqual(frames.filter((frame) => FORBIDDEN_FRAMES.has(frame.type)), [], `${what}: navigation sent input, keys or a take-over`);
  assert.deepEqual(posts.filter((post) => FORBIDDEN_POST.test(post.path)), [], `${what}: navigation asked herdr to focus, type or take over`);
  return calls;
}

interface Session { context: BrowserContext; page: Page; errors: string[] }
async function open(browser: Browser, options: { mobile?: boolean; platform?: string; settings?: object; pins?: string[]; query?: string; dpr?: number }): Promise<Session> {
  const context = await browser.newContext({
    viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    deviceScaleFactor: options.dpr ?? (options.mobile ? 3 : 1),
    isMobile: options.mobile ?? false, hasTouch: options.mobile ?? false, locale: "en-US",
  });
  await context.addInitScript(({ settings, pins, platform }) => {
    if (platform) Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, ...settings }));
    localStorage.setItem("herdr-web-ui:sidebar-agent-pins", JSON.stringify(pins));
    for (const id of ["local", "remote"]) localStorage.setItem(`herdr-web-ui:pc-collapsed:${id}`, "1");
  }, { settings: options.settings ?? {}, pins: options.pins ?? [], platform: options.platform ?? null });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}${options.query ?? ""}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(`.agents-sidebar .agent-item[data-machine="remote"]`).first().waitFor({ state: "attached" });
  return { context, page, errors };
}
async function close(session: Session, name: string): Promise<void> {
  try { assert.deepEqual(session.errors, [], `${name}: page errors`); }
  finally { await session.context.close(); }
}
function record(name: string, body: object): void {
  if (!evidence) return;
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(body, null, 2));
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(join(app, "attention-fixture.js"), `(${installAttentionFixture.toString()})();`);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./attention-fixture.js"></script>\n    <script type="module"'));
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // ---- the cycle: pinned first, blocked before finishes, the list's order, the wrap, a finish read dropping out ----
      {
        const pins = [`remote:${panes.flaky}`, `local:${panes.hermes}`];
        const session = await open(browser, { pins });
        const { page } = session;
        const keys = await chord(page);
        const steps: { action: string; selection: string | null }[] = [];
        // local: WEB blocked, INFRA and HERMES finished; remote: WEB blocked, FLAKY finished. The
        // list: the pinned card [remote FLAKY, local HERMES], then local in herdr's order, then remote.
        await setStatuses(page, quiet(["local", panes.web, "blocked", 2], ["local", panes.omp, "done", 2], ["local", panes.hermes, "done", 2], ["remote", panes.web, "blocked", 2], ["remote", panes.flaky, "done", 2]));
        await waitStatus(page, "remote", panes.flaky, "done");
        await waitStatus(page, "local", panes.web, "blocked");
        // the finishes stay unread while their conversations are on their way: the order alone is under test
        for (const [machine, pane] of [["local", panes.omp], ["local", panes.hermes], ["remote", panes.flaky]] as const) await page.evaluate(([m, p]) => window.attentionFixture.hold(m, p), [machine, pane] as const);
        const before = await wireCalls(page);
        const expected = [target("local", panes.web), target("remote", panes.web), target("remote", panes.flaky), target("local", panes.hermes), target("local", panes.omp), target("local", panes.web)];
        for (const [index, want] of expected.entries()) {
          // the first press is held: its key repeats must not jump on, past finishes nobody read
          const got = index === 0 ? await hold(page, keys, 3) : await press(page, keys);
          steps.push({ action: index === 0 ? "press 1, held through 3 key repeats" : `press ${index + 1}`, selection: got });
          assert.equal(got, want, `press ${index + 1}${index === 0 ? " (held through 3 key repeats: one press, one jump)" : ""}: blocked first, then finishes, the list's order, round again`);
          const [machine, pane] = want.split("/") as [string, string];
          await waitSelected(page, machine, pane);
          // the pane opens over its own PC's socket: an attach there, never input or a take-over
          await page.waitForFunction(([machineId, paneId]) => window.attentionFixture.calls.ws.some((frame) => frame.machine === machineId && frame.type === "attach" && frame.pane_id === paneId), [machine, pane] as const, { timeout: 10_000 });
        }
        const after = await assertSelectionOnly(page, before, "cycle");
        const seenRecords = () => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:finish:")));
        assert.deepEqual(await seenRecords(), [], "finishes whose conversation is still on its way stay unread");
        console.log("PASS the cycle walks the pinned card, then blocked, then unread finishes in the list's order, and wraps");

        // the blocked ones answered: only the finishes are left, and each one opened here is read and leaves the cycle
        await page.evaluate(() => window.attentionFixture.release());
        await setStatuses(page, [["local", panes.web, "working", 3], ["remote", panes.web, "working", 3]]);
        await waitStatus(page, "local", panes.web, "working");
        for (const [index, [machine, pane]] of ([["remote", panes.flaky], ["local", panes.hermes], ["local", panes.omp]] as const).entries()) {
          const got = await press(page, keys);
          steps.push({ action: `finish ${index + 1}`, selection: got });
          assert.equal(got, target(machine, pane), `finish ${index + 1}: the first unread finish in the list's order`);
          await waitSelected(page, machine, pane);
          // opened in front, its finish is looked at: the row reads as ready and the record is shared
          await waitStatus(page, machine, pane, "idle");
        }
        assert.equal((await seenRecords()).length, 3, "each finish opened here is recorded");
        const none = await press(page, keys);
        steps.push({ action: "press with nothing left", selection: none });
        assert.equal(none, target("local", panes.omp), "nothing left to go to: the selection stays");
        // a live change brings a candidate back: the remote's Claude pane asks for input
        await setStatuses(page, [["remote", panes.api, "blocked", 4]]);
        await waitStatus(page, "remote", panes.api, "blocked");
        const live = await press(page, keys);
        steps.push({ action: "press after a live block", selection: live });
        assert.equal(live, target("remote", panes.api));
        await waitSelected(page, "remote", panes.api);
        await setStatuses(page, [["remote", panes.api, "working", 5], ["local", panes.cli, "done", 2]]);
        await waitStatus(page, "local", panes.cli, "done");
        const finished = await press(page, keys);
        steps.push({ action: "press after a live finish", selection: finished });
        assert.equal(finished, target("local", panes.cli));
        await waitSelected(page, "local", panes.cli);
        await waitStatus(page, "local", panes.cli, "idle");
        const calls = await assertSelectionOnly(page, after, "finishes");
        record("task-5-aoe-borrowings-attention-cycle", { scenario: "attention cycle", pins, steps, seen: await seenRecords(), ws: calls.ws, posts: calls.posts, verdict: "PASS" });
        await close(session, "cycle");
        console.log("PASS a finish opened here leaves the cycle through the shared record, nothing left is a no-op, and live changes join");
      }

      // ---- identity, a PC away, nothing to go to, a composing chord: a phone with an Apple platform ----
      {
        const session = await open(browser, { mobile: true, platform: "iPad" });
        const { page } = session;
        const keys = await chord(page);
        assert.equal(keys, "Meta+Shift+A");
        const steps: { action: string; selection: string | null }[] = [];
        await setStatuses(page, quiet(["local", panes.web, "blocked", 2], ["remote", panes.web, "blocked", 2]));
        await waitStatus(page, "remote", panes.web, "blocked");
        const before = await wireCalls(page);
        const first = await press(page, keys);
        steps.push({ action: "press", selection: first });
        assert.equal(first, target("local", panes.web));
        await waitSelected(page, "local", panes.web);
        const second = await press(page, keys);
        steps.push({ action: "press", selection: second });
        assert.equal(second, target("remote", panes.web), "the same pane id on the other PC is its own target");
        await waitSelected(page, "remote", panes.web);
        assert.equal(await page.locator(".pane-frame.is-current").getAttribute("data-layout-pane"), panes.web);
        // the remote goes away while its pane is open: its saved roster is no target
        await page.evaluate(() => window.attentionFixture.remote("disconnected"));
        await page.locator('.machine-group.is-offline[aria-label="PC Build PC"]').waitFor({ state: "attached" });
        await page.locator(`.agents-sidebar .agent-item.is-offline[data-machine="remote"][data-pane="${panes.web}"]`).waitFor({ state: "attached" });
        const away = await press(page, keys);
        steps.push({ action: "press with the remote away", selection: away });
        assert.equal(away, target("local", panes.web), "a PC away is skipped, whatever its saved roster says");
        await waitSelected(page, "local", panes.web);
        const alone = await press(page, keys);
        steps.push({ action: "press as the sole candidate", selection: alone });
        assert.equal(alone, target("local", panes.web), "the sole candidate wraps to itself");
        await page.evaluate(() => window.attentionFixture.remote("connected"));
        await page.locator(`.agents-sidebar .agent-item[data-machine="remote"][data-pane="${panes.web}"]:not(.is-offline)`).waitFor({ state: "attached" });
        await waitStatus(page, "remote", panes.web, "blocked");
        const back = await press(page, keys);
        steps.push({ action: "press with the remote back", selection: back });
        assert.equal(back, target("remote", panes.web));
        await waitSelected(page, "remote", panes.web);
        // nothing waits: the press is a no-op, the selection and the wire untouched
        await setStatuses(page, [["local", panes.web, "idle", 3], ["remote", panes.web, "idle", 3]]);
        await waitStatus(page, "remote", panes.web, "idle");
        await waitStatus(page, "local", panes.web, "idle");
        const quietWire = await wireCalls(page);
        const nothing = await press(page, keys);
        steps.push({ action: "press with nothing to go to", selection: nothing });
        assert.equal(nothing, target("remote", panes.web), "an empty candidate list changes nothing");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await selection(page), target("remote", panes.web));
        assert.equal((await wireCalls(page)).ws.length, quietWire.ws.length, "a no-op sends nothing");
        // a chord inside an IME composition is the composition's, never the app's
        await setStatuses(page, [["local", panes.web, "blocked", 4]]);
        await waitStatus(page, "local", panes.web, "blocked");
        for (const patch of [{ isComposing: true }, { keyCode: 229 }]) {
          await page.evaluate((init) => {
            const event = new KeyboardEvent("keydown", { key: "A", code: "KeyA", metaKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
            (document.activeElement ?? document.body).dispatchEvent(event);
          }, patch);
          assert.equal(await selection(page), target("remote", panes.web), `a composing chord (${JSON.stringify(patch)}) is not dispatched`);
        }
        const real = await press(page, keys);
        steps.push({ action: "press after the composing chords", selection: real });
        assert.equal(real, target("local", panes.web));
        await waitSelected(page, "local", panes.web);
        const calls = await assertSelectionOnly(page, before, "identity");
        record("task-5-aoe-borrowings-identity-offline-no-targets", { scenario: "identity, offline PC, no targets, IME", steps, ws: calls.ws, posts: calls.posts, verdict: "PASS" });
        await close(session, "identity");
        console.log("PASS duplicate pane ids stay machine scoped, a PC away is skipped, the sole candidate wraps to itself, nothing to go to is a no-op, and composing chords are not dispatched");
      }

      // ---- the palette's action runs the same jump ----
      {
        const session = await open(browser, {});
        const { page } = session;
        await setStatuses(page, quiet(["remote", panes.omp, "blocked", 2]));
        await waitStatus(page, "remote", panes.omp, "blocked");
        // an opener outside every pane, counting the focus it is given back: in a split tab the opener is a
        // pane, and that focus alone selects it again (PaneCanvas onFocusCapture), whatever takes focus next
        const opener = () => page.evaluate(() => {
          let probe = document.getElementById("palette-opener-probe");
          if (!probe) {
            const created = document.body.appendChild(Object.assign(document.createElement("button"), { id: "palette-opener-probe", textContent: "opener" }));
            created.addEventListener("focus", () => { created.dataset.focused = String(Number(created.dataset.focused ?? "0") + 1); });
            probe = created;
          }
          probe.focus();
          probe.dataset.focused = "0";
        });
        const openerRefocused = () => page.evaluate(() => Number(document.getElementById("palette-opener-probe")?.dataset.focused ?? "0") > 0);
        const runFromPalette = async () => {
          await page.keyboard.press((await chord(page)).replace("A", "K"));
          const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
          await palette.waitFor();
          await palette.getByRole("searchbox").fill(">next agent");
          const action = palette.getByRole("option", { name: /^Next agent needing attention/ });
          await action.waitFor();
          assert.match(await action.innerText(), /Next agent needing attention/);
          await action.click();
          // the focus goes back (or not) in the commit that removes the palette
          await palette.waitFor({ state: "detached" });
        };
        await opener();
        await runFromPalette();
        await waitSelected(page, "remote", panes.omp);
        assert.equal(await openerRefocused(), false, "a jump from the palette does not hand focus back to its opener");
        // nothing waits any more: the action is a no-op, and the opener gets focus back as after any other action
        await setStatuses(page, [["remote", panes.omp, "working", 3]]);
        await waitStatus(page, "remote", panes.omp, "working");
        await opener();
        await runFromPalette();
        assert.equal(await selection(page), target("remote", panes.omp), "nothing to go to: the selection stays");
        assert.equal(await openerRefocused(), true, "with nothing to go to, the opener gets focus back");
        await close(session, "palette");
        console.log("PASS the palette's Next agent needing attention runs the jump, and gives focus back to its opener only when it did not move");
      }

      // ---- a watching device: both PCs' sockets acknowledged as observers, and the jump still only moves the selection ----
      {
        const session = await open(browser, { query: "&observe=1", settings: { defaultView: "terminal" } });
        const { page } = session;
        const keys = await chord(page);
        await setStatuses(page, quiet(["local", panes.omp, "blocked", 2], ["remote", panes.web, "blocked", 2]));
        await waitStatus(page, "remote", panes.web, "blocked");
        await waitObserver(page, "local");
        const before = await wireCalls(page);
        const steps: { action: string; selection: string | null }[] = [];
        // the first press opens the remote's socket: it is acknowledged as an observer before the next press
        const expected = [target("local", panes.omp), target("remote", panes.web), target("local", panes.omp), target("remote", panes.web)];
        for (const [index, want] of expected.entries()) {
          const got = await press(page, keys);
          steps.push({ action: `observe press ${index + 1}`, selection: got });
          assert.equal(got, want, `observe press ${index + 1}: the jump still moves this browser's selection`);
          const [machine, pane] = want.split("/") as [string, string];
          await waitSelected(page, machine, pane);
          await waitObserver(page, machine);
        }
        const calls = await assertSelectionOnly(page, before, "observe");
        const frames = calls.ws.slice(before.ws.length);
        assert.deepEqual(frames.filter((frame) => frame.type === "resize"), [], "an observer's navigation resizes no pane");
        assert.deepEqual([...new Set(calls.acks.map((ack) => ack.machine))].sort(), ["local", "remote"], "both PCs answered a role");
        assert.ok(calls.acks.every((ack) => ack.mode === "observe"), "no socket of a watching device is acknowledged as interact");
        record("task-5-aoe-borrowings-observe", { scenario: "observe-only device", steps, acks: calls.acks, ws: frames, posts: calls.posts.slice(before.posts.length), verdict: "PASS" });
        await close(session, "observe");
        console.log("PASS a watching device: both PCs acknowledged as observers, the jump moves only the selection, and no input, keys, submit, take-over or resize is sent");
      }

      if (evidence) await captures(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}

/**
 * The selected attention row, the palette's action and the Settings row, at a phone's width (390,
 * DPR 3, touch) and a desktop's (1440) in both themes, Korean at 390, with the states a reviewer
 * checks: rest, hover (desktop), keyboard focus, pressed, nothing to go to, a long label, a PC
 * away, a watching browser, and each list's end. Each file is named and hashed in manifest.json.
 */
async function captures(browser: Browser): Promise<void> {
  const manifest: { file: string; width: number; height: number; theme: string; language: string; state: string; sha256: string; capturedAt: string }[] = [];
  const LONG = "Guard the export button against a very long unbroken identifier aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  for (const theme of ["light", "dark"] as const) {
    for (const device of [{ width: 1440, mobile: false }, { width: 390, mobile: true }] as const) {
      for (const language of device.mobile ? ["en", "ko"] as const : ["en"] as const) {
        const suffix = language === "ko" ? "-ko" : "";
        const shot = async (page: Page, state: string, options: { clip?: { x: number; y: number; width: number; height: number } } = {}) => {
          const file = `attention-jump-${device.width}-${theme}${suffix}-${state}.png`;
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const path = join(evidence!, file);
          await page.screenshot({ path, ...(options.clip ? { clip: options.clip } : {}) });
          const size = await page.viewportSize();
          manifest.push({ file, width: size?.width ?? device.width, height: size?.height ?? 0, theme, language, state, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), capturedAt: new Date().toISOString() });
        };
        const viewport = device.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
        const openFor = async (query = "", pins: string[] = [], settings: object = {}) => {
          const session = await open(browser, { mobile: device.mobile, platform: device.mobile ? "iPad" : undefined, settings: { language, theme, ...settings }, pins, query });
          await session.page.setViewportSize(viewport);
          return session;
        };
        const row = (page: Page, machine: string, pane: string) => page.locator(`.agents-sidebar .agent-item[data-machine="${machine}"][data-pane="${pane}"] .agent-select`);
        // the phone's drawer slides in and its Agents section unfolds: the shot waits for both to settle
        const settled = (page: Page) => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
        const showList = async (page: Page) => {
          if (!device.mobile) return;
          const drawer = page.locator('button[aria-controls="workspace-drawer"]');
          if (await drawer.getAttribute("aria-expanded") !== "true") await drawer.click();
          await page.locator(".sidebar.is-open").waitFor();
          const toggle = page.locator(".agents-sidebar .agent-section-toggle");
          if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
          await page.locator(".agents-sidebar .agent-list-contents:not([hidden])").waitFor();
          await settled(page);
        };
        const listEnd = (page: Page) => page.locator(".agents-sidebar .agent-list-contents").evaluate((node) => { node.scrollTop = node.scrollHeight; });

        // the selected row: rest, hover, focus, pressed, the list's end, and the no-op after
        {
          const session = await openFor("", [`remote:${panes.flaky}`]);
          const { page } = session;
          const keys = await chord(page);
          await setStatuses(page, quiet(["local", panes.web, "blocked", 2], ["remote", panes.flaky, "done", 2], ["remote", panes.omp, "blocked", 2]));
          await waitStatus(page, "local", panes.web, "blocked");
          await press(page, keys);
          await waitSelected(page, "local", panes.web);
          await showList(page);
          await shot(page, "selected");
          const selected = row(page, "local", panes.web);
          if (!device.mobile) { await selected.hover(); await shot(page, "hover"); await page.mouse.move(0, 0); }
          await page.keyboard.press("Shift");
          await selected.focus();
          await page.locator(".agents-sidebar .agent-item.is-selected .agent-select:focus-visible").waitFor();
          await shot(page, "focus");
          const box = (await selected.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await shot(page, "pressed");
          await page.mouse.up();
          await waitSelected(page, "local", panes.web);
          await showList(page);
          await listEnd(page);
          await shot(page, "list-end");
          await setStatuses(page, quiet());
          await waitStatus(page, "local", panes.web, "idle");
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await press(page, keys);
          await showList(page);
          await shot(page, "empty");
          await close(session, `captures ${device.width} ${theme} ${language} selected`);
        }
        // a long label on the row jumped to, a PC away, and a browser that only watches
        {
          const session = await openFor();
          const { page } = session;
          const keys = await chord(page);
          await setStatuses(page, quiet(["local", panes.web, "blocked", 2], ["remote", panes.web, "blocked", 2]));
          await page.evaluate(([pane, label]) => window.attentionFixture.label("local", pane, label), [panes.web, LONG] as const);
          await page.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${panes.web}"] .agent-title`, { hasText: "unbroken" }).waitFor({ state: "attached" });
          await press(page, keys);
          await waitSelected(page, "local", panes.web);
          await showList(page);
          await shot(page, "long-label");
          await page.evaluate(() => window.attentionFixture.remote("disconnected"));
          await page.locator('.machine-group.is-offline[aria-label="PC Build PC"]').waitFor({ state: "attached" });
          await showList(page);
          await shot(page, "offline-pc");
          await close(session, `captures ${device.width} ${theme} ${language} long/offline`);
        }
        {
          // the terminal lens draws the View only banner of an acknowledged observer
          const session = await openFor("&observe=1", [], { defaultView: "terminal" });
          const { page } = session;
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await setStatuses(page, quiet(["remote", panes.web, "blocked", 2]));
          await waitStatus(page, "remote", panes.web, "blocked");
          await waitObserver(page, "local");
          await press(page, await chord(page));
          await waitSelected(page, "remote", panes.web);
          await waitObserver(page, "remote");
          await showList(page);
          await shot(page, "observe");
          await close(session, `captures ${device.width} ${theme} ${language} observe`);
        }
        // the palette's action and the Settings row
        {
          const session = await openFor();
          const { page } = session;
          const keys = await chord(page);
          await setStatuses(page, quiet(["local", panes.web, "blocked", 2]));
          await waitStatus(page, "local", panes.web, "blocked");
          await page.keyboard.press(keys.replace("A", "K"));
          const palette = page.getByRole("dialog", { name: /Command palette|명령 팔레트/ });
          await palette.waitFor();
          await palette.getByRole("searchbox").fill(">");
          const action = palette.getByRole("option", { name: /Next agent needing attention|확인이 필요한 다음 에이전트/ });
          await action.waitFor();
          await action.scrollIntoViewIfNeeded();
          await shot(page, "palette");
          if (!device.mobile) { await action.hover(); await shot(page, "palette-hover"); }
          await palette.locator(".palette-results").evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await shot(page, "palette-end");
          await page.keyboard.press("Escape");
          await palette.waitFor({ state: "detached" });
          await page.keyboard.press(keys.replace("A", "Comma"));
          await openSettingsPage(page, language === "ko" ? "단축키" : "Shortcuts", language === "ko" ? "설정으로 돌아가기" : "Back to settings");
          // the row's Record button names the shortcut in the page's language (its aria-label)
          const settingsRow = page.locator(".settings-dialog .settings-shortcut-record").filter({ hasText: /.*/ }).and(page.getByRole("button", { name: /Next agent needing attention|확인이 필요한 다음 에이전트/ }));
          await settingsRow.waitFor();
          await settingsRow.scrollIntoViewIfNeeded();
          await shot(page, "settings");
          await page.locator(".settings-dialog").getByRole("tabpanel").evaluate((node) => { const scroller = node.closest<HTMLElement>(".settings-page, .settings-body, .settings-content") ?? node; scroller.scrollTop = scroller.scrollHeight; });
          await page.evaluate(() => { for (const node of document.querySelectorAll<HTMLElement>(".settings-dialog *")) if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== "visible") node.scrollTop = node.scrollHeight; });
          await shot(page, "settings-end");
          await close(session, `captures ${device.width} ${theme} ${language} palette/settings`);
        }
      }
    }
  }
  writeFileSync(join(evidence!, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`PASS captured ${manifest.length} screenshots into ${evidence}`);
}
