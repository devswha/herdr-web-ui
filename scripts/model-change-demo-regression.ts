import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";

// Real client, fictional demo transport, no user's herdr or terminal involved.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-model-demo-"));
const select = async (page: Page, pane: string) => {
  const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
  await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
  if (!await page.locator(".terminal-stack.is-chat").count()) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
};
try {
  const build = Bun.spawnSync([join(repo, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", app, "--emptyOutDir", "--logLevel", "warn"], { cwd: repo });
  assert.equal(build.exitCode, 0, new TextDecoder().decode(build.stderr));
  const transport = await Bun.build({ entrypoints: [join(repo, "site/demo/transport.ts")], outdir: app, naming: "demo-transport.js", target: "browser", define: { __APP_VERSION__: '"demo"' } });
  assert.ok(transport.success, transport.logs.map(String).join("\n"));
  // Hold/reject submit acknowledgements to exercise real client send ownership and errors.
  const hooks = `<script>(() => {
    window.submits = []; window.hold = false; window.reject = false; window.releases = [];
    const Demo = window.WebSocket;
    const Socket = function (...args) {
      const socket = new Demo(...args); window.demoSocket = socket; const send = socket.send.bind(socket);
      socket.send = data => {
        const message = JSON.parse(data);
        if (message.type !== 'submit') return send(data);
        window.submits.push(message);
        const deliver = () => window.reject ? socket.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({type:'submit-result', id:message.id, pane_id:message.pane_id, ok:false, code:'agent_blocked', message:'waiting'})})) : send(data);
        if (window.hold) window.releases.push(deliver); else deliver();
      }; return socket;
    };
    for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) Object.defineProperty(Socket,k,{value:Demo[k]});
    window.WebSocket = Socket;
    const fetchDemo = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes('/api/pane/image')) return Response.json({path:'/tmp/demo-attachment.txt'});
      const response = await fetchDemo(input, init);
      if (String(input).includes('/api/pane/prompt?') && window.hideModelMenu) {
        window.hiddenPromptReads = (window.hiddenPromptReads ?? 0) + 1;
        return Response.json({prompt:null, suggestion:null});
      }
      if (String(input).includes('/api/pane/conversation') && window.modelMetadata !== undefined) {
        const body = await response.json(); body.metadata = window.modelMetadata;
        return Response.json(body);
      }
      return response;
    };
  })();</script>`;
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${hooks}<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(pathname.slice(prefix.length)) || "index.html";
    if (path.split("/").includes("..")) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(app, path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.infra)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".composer").waitFor();
      assert.equal(await page.locator(".composer-model-change").count(), 0, "unsupported agent is display only");
      await select(page, panes.api);
      assert.ok(await page.getByRole("button", { name: "Change model", exact: true }).isDisabled(), "working agent disabled");
      await select(page, panes.web);
      await page.locator(".prompt-card").waitFor();
      assert.ok(await page.getByRole("button", { name: "Change model", exact: true }).isDisabled(), "open prompt disabled");
      await page.keyboard.press("Escape");
      await page.locator('.composer textarea').click();
      assert.equal(await page.locator('.prompt-card').count(), 1, 'approvals are not dismissed by model-menu gestures');

      for (const agent of ["claude", "codex", "pi"]) {
        const pane = await page.evaluate(async (kind) => (await (await fetch('/api/workspace/create', {method:'POST', body:JSON.stringify({cwd:'/home/demo/model-test',agent:{kind}})})).json()).pane_id as string, agent);
        await select(page, pane);
        const button = page.getByRole("button", { name: "Change model", exact: true });
        await page.waitForFunction(() => !(document.querySelector('.composer-model-change') as HTMLButtonElement)?.disabled);
        const input = page.locator(".composer textarea");
        assert.ok(await page.locator('.composer-model-label').isVisible(), 'current model is shown before opening');
        assert.ok(await page.locator('.composer-reasoning-short').isVisible(), 'current effort is shown before opening');
        await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
        await page.waitForFunction(() => document.querySelector('.composer-surface')?.hasAttribute('data-model-row'));
        assert.ok(await page.locator('.composer-reasoning-short').isVisible(), 'current effort stays visible at 200% zoom');
        const zoomedLabels = await page.evaluate(() => {
          const model = document.querySelector<HTMLElement>('.composer-model-label')!;
          const effort = document.querySelector<HTMLElement>('.composer-reasoning-short')!;
          const pill = document.querySelector<HTMLElement>('.composer-pill')!;
          const status = document.querySelector<HTMLElement>('.composer-status')!;
          const send = document.querySelector<HTMLElement>('.composer-send')!;
          const pillBox = pill.getBoundingClientRect();
          const sendBox = send.getBoundingClientRect();
          const first = pill.querySelector<HTMLElement>('.agent-mark')!.getBoundingClientRect();
          const last = pill.querySelector<HTMLElement>('.composer-reasoning.is-switchable')!.getBoundingClientRect();
          return { model: model.textContent, effort: effort.textContent, modelWhole: model.scrollWidth <= model.clientWidth, effortWhole: effort.scrollWidth <= effort.clientWidth, modelWidth: [model.scrollWidth, model.clientWidth], pillWidth: pillBox.width, statusWidth: status.getBoundingClientRect().width, contentSlack: pillBox.width - (last.right - first.left), pillCenter: pillBox.top + pillBox.height / 2, sendCenter: sendBox.top + sendBox.height / 2, draw: status.getAttribute('data-model'), row: document.querySelector('.composer-surface')?.hasAttribute('data-model-row') };
        });
        assert.equal(zoomedLabels.modelWhole, true, `current model stays whole at 200% zoom: ${JSON.stringify(zoomedLabels)}`);
        assert.equal(zoomedLabels.effortWhole, true, `current effort stays whole at 200% zoom: ${JSON.stringify(zoomedLabels)}`);
        assert.ok(zoomedLabels.pillWidth < zoomedLabels.statusWidth, `model pill stays inside the status row at 200% zoom: ${JSON.stringify(zoomedLabels)}`);
        assert.ok(zoomedLabels.contentSlack <= 64, `model pill grows only by its content and padding at 200% zoom: ${JSON.stringify(zoomedLabels)}`);
        assert.ok(Math.abs(zoomedLabels.pillCenter - zoomedLabels.sendCenter) <= 4, `send button stays on the model row at 200% zoom: ${JSON.stringify(zoomedLabels)}`);
        await page.locator('.composer').screenshot({ path: `/tmp/herdr-model-change-${agent}-zoom.png` });
        await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
        assert.equal(await page.locator('.prompt-card').count(), 0);

        await input.fill("Keep this draft");
        await page.locator('.composer input[type="file"]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('test attachment') });
        await page.locator('.composer-attachment.is-ready').waitFor();
        const draft = await input.inputValue();
        await page.evaluate(() => { (window as any).hold = true; (window as any).submits = []; (window as any).hideModelMenu = true; (window as any).hiddenPromptReads = 0; });
        await button.focus();
        await page.keyboard.press("Enter");
        assert.ok(await button.isDisabled(), "pending request disabled");
        await button.evaluate((node: HTMLButtonElement) => node.click());
        assert.equal(await page.evaluate(() => (window as any).submits.length), 1, "double click sends only once");
        assert.equal(await input.inputValue(), draft);
        await page.evaluate(() => { (window as any).hold = false; (window as any).releases.splice(0).forEach((run: () => void) => run()); });
        await page.waitForFunction(() => (window as any).hiddenPromptReads > 0);
        assert.ok(await button.isDisabled(), 'acknowledged submit stays locked until its menu arrives');
        await page.evaluate(() => { (window as any).hideModelMenu = false; });
        await page.locator(".prompt-card").waitFor();
        assert.ok(await button.isDisabled());
        const expected = agent === "claude" ? "claude-sonnet-5" : "gpt-6";
        await page.locator(".prompt-card-option").filter({ hasText: expected }).click();
        if (agent === "codex") await page.locator(".prompt-card-option").filter({ hasText: "medium" }).click();
        await page.locator(".prompt-card").waitFor({ state: "detached" });
        await page.waitForFunction((id) => document.querySelector('.composer-model-change')?.getAttribute('title') === id, expected);
        assert.equal(await input.inputValue(), draft);
        assert.equal(await page.locator(".composer-attachment.is-ready").count(), 1);
        await button.click();
        await page.locator(".prompt-card-option").filter({ hasText: "Cancel" }).click();
        await page.locator(".prompt-card").waitFor({ state: "detached" });
        assert.equal(await button.getAttribute("title"), expected);
        const effort = await page.locator('.composer-reasoning-short').textContent();
        await button.click();
        await page.locator('.prompt-card').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('.prompt-card').waitFor({state:'detached'});
        assert.equal(await button.getAttribute('title'), expected, 'Escape keeps the original model');
        assert.equal(await page.locator('.composer-reasoning-short').textContent(), effort);
        await page.waitForFunction(() => !(document.querySelector('.composer-model-change') as HTMLButtonElement)?.disabled);
        await button.click();
        await page.locator('.prompt-card').waitFor();
        await input.click();
        await page.locator('.prompt-card').waitFor({state:'detached'});
        assert.equal(await button.getAttribute('title'), expected, 'outside click keeps the original model');
        assert.equal(await input.inputValue(), draft);
        assert.equal(await page.locator('.composer-reasoning-short').textContent(), effort);
        await page.waitForFunction(() => !(document.querySelector('.composer-model-change') as HTMLButtonElement)?.disabled);
        const effortButton = page.getByRole('button', { name: 'Change reasoning effort', exact: true });
        await effortButton.click();
        await page.locator('.prompt-card-option').filter({hasText:'high'}).waitFor();
        await page.keyboard.press('Escape');
        await page.locator('.prompt-card').waitFor({state:'detached'});
        assert.equal(await page.locator('.composer-reasoning-short').textContent(), effort);
        await effortButton.click();
        await page.locator('.prompt-card-option').filter({hasText:'high'}).waitFor();
        await input.click();
        await page.locator('.prompt-card').waitFor({state:'detached'});
        assert.equal(await page.locator('.composer-reasoning-short').textContent(), effort);
        await effortButton.click();
        await page.locator('.prompt-card-option').filter({hasText:'high'}).click();
        await page.locator('.prompt-card').waitFor({state:'detached'});
        await page.waitForFunction(() => document.querySelector('.composer-reasoning-short')?.textContent === 'high');
        assert.equal(await button.getAttribute('title'), expected, 'effort changes preserve model');
        assert.equal(await input.inputValue(), draft);
        assert.equal(await page.locator('.composer-attachment.is-ready').count(), 1);
        await page.evaluate(() => { (window as any).reject = true; });
        await button.click();
        await page.getByText("Not sent: the agent is waiting for an answer in the terminal. Answer it first.", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), draft);
        await page.evaluate(() => { (window as any).reject = false; });
        console.log(`PASS ${agent}: keyboard open, single submit, select, Escape/outside dismiss, cancel, failure, draft preservation`);
      }
      await page.evaluate(() => { (window as any).hideModelMenu = true; (window as any).submits = []; });
      const keptDraft = await page.locator('.composer textarea').inputValue();
      await page.getByRole('button', { name:'Change model', exact:true }).click();
      await page.getByText('Model menu did not open. Check the terminal before trying again.', {exact:true}).waitFor({timeout:8_000});
      assert.equal(await page.locator('.composer textarea').inputValue(), keptDraft);
      assert.equal(await page.evaluate(() => (window as any).submits.length), 1, 'menu timeout never resends');
      await page.evaluate(() => { (window as any).hideModelMenu = false; });
      await page.locator('.prompt-card-option').filter({hasText:'Cancel'}).click();
      await page.locator('.prompt-card').waitFor({state:'detached'});
      console.log('PASS missing menu deadline reports failure without resending or clearing the draft');

      // A pending submit belongs to its original pane; it must not open a menu or show an error in another.
      await page.evaluate(() => { (window as any).hold = true; (window as any).reject = true; });
      await page.getByRole("button", { name: "Change model", exact: true }).click();
      await select(page, panes.infra);
      await page.evaluate(() => { (window as any).hold = false; (window as any).releases.splice(0).forEach((run: () => void) => run()); });
      assert.equal(await page.locator('.prompt-card').count(), 0);
      assert.equal(await page.getByText("Not sent: the agent is waiting for an answer in the terminal. Answer it first.", { exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      console.log("PASS late result after pane switch stays with its owner");

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" });
      try {
        await phone.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
        const mobile = await phone.newPage();
        await mobile.goto(page.url());
        await mobile.locator('.conn-live').waitFor({ state: 'attached' });
        const pane = await mobile.evaluate(async () => (await (await fetch('/api/workspace/create', {method:'POST', body:JSON.stringify({cwd:'/home/demo/model-test',agent:{kind:'codex'}})})).json()).pane_id as string);
        await select(mobile, pane);
        const button = mobile.getByRole('button', { name: 'Change model', exact: true });
        await mobile.waitForFunction(() => !(document.querySelector('.composer-model-change') as HTMLButtonElement)?.disabled);
        for (const model of [null, 'very-long-unknown-model-id-that-does-not-fit-on-a-phone-2026']) {
          await mobile.evaluate((model) => { (window as any).modelMetadata = {model, reasoning_effort:'high', context:{used:151000, window:272000}}; }, model);
          await mobile.waitForFunction((id) => document.querySelector('.composer-model-change')?.getAttribute('title') === (id ?? 'Change model'), model, {timeout: 8_000}).catch(async (error) => { console.log('PHONE metadata', await mobile.evaluate(() => ({title:document.querySelector('.composer-model-change')?.getAttribute('title'), visible:document.visibilityState, override:(window as any).modelMetadata}))); throw error; });
          const count = await mobile.evaluate(() => (window as any).submits.length);
          await mobile.locator('.composer-context').click();
          assert.equal(await mobile.evaluate(() => (window as any).submits.length), count, 'context ring does not submit');
          assert.ok(await button.isVisible());
          const box = await button.boundingBox();
          const layout = await mobile.evaluate(() => ({ draw: document.querySelector('.composer-status')?.getAttribute('data-model'), row: document.querySelector('.composer-surface')?.hasAttribute('data-model-row') }));
          assert.ok(box && box.width >= 14 && box.x >= 0 && box.x + box.width <= 390, `model control outside phone: ${JSON.stringify({ box, layout })}`);
          await button.tap();
          await mobile.locator('.prompt-card').waitFor();
          await mobile.screenshot({ path: '/tmp/herdr-model-change-mobile.png' });
          await mobile.locator('.composer textarea').tap();
          await mobile.locator('.prompt-card').waitFor({state:'detached'});
          assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
        await mobile.evaluate(() => (window as any).demoSocket.close(4008, 'test disconnected'));
        await button.waitFor({state:'detached'});
        const count = await mobile.evaluate(() => (window as any).submits.length);
        assert.equal(await mobile.locator('.composer-model-change').count(), 0, 'stopped connection offers no action');
        assert.equal(await mobile.evaluate(() => (window as any).submits.length), count);
        console.log('PASS phone: missing/long model, context independent, touch open, offline guard; /tmp/herdr-model-change-mobile.png');
      } finally { await phone.close(); }
      await context.close();
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
