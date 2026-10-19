import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Before its first message omp has written no session and a Codex started in a terminal has
// reported none: the model is read off their own status lines, through real herdr screens.
const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-start-screen-contract-"));
const fresh = join(root, ".omp", "agent", "sessions", "-start-screen", "2026-10-19T00-00-00-000Z_omp-fresh.jsonl");
const originalHome = process.env["HOME"];
const workspaces: string[] = [];
let ompPane: string;
let codexPane: string;
let server: ReturnType<typeof createServer>;
let seq = Date.now() * 1000;

// a stand-in omp: `models --json` lists its catalog; otherwise it draws omp's status line, and
// draws another model on `s`, as `/switch` does
const FAKE_OMP = `
const catalog = { models: [
  { provider: "anthropic", kind: "chat", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "openai-codex", kind: "chat", id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
] };
if (process.argv.includes("models")) { console.log(JSON.stringify(catalog)); process.exit(0); }
const draw = (model) => process.stdout.write("\\x1b[2J\\x1b[H π > " + model + " > 🗑 project ▶─2%─┃─1M─\\r\\n");
draw("◔ GPT 6.1 Sol");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (key) => { if (String(key).includes("s")) draw("◒ Opus 5.5"); });
`;

beforeAll(async () => {
  mkdirSync(join(root, ".omp", "agent", "sessions", "-start-screen"), { recursive: true });
  const fakeOmp = join(root, "omp");
  writeFileSync(fakeOmp, FAKE_OMP);
  const omp = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-start-screen-omp" });
  workspaces.push(omp.workspace.workspace_id);
  ompPane = omp.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: ompPane, text: `${process.execPath} ${fakeOmp}\n` });
  await herdrRpc("pane.report_agent", { pane_id: ompPane, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: ompPane, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: fresh, session_start_source: "startup" });
  const codex = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-start-screen-codex" });
  workspaces.push(codex.workspace.workspace_id);
  codexPane = codex.root_pane.pane_id;
  await herdrRpc("pane.report_agent", { pane_id: codexPane, source: "manual", agent: "codex", state: "idle" });
  await herdrRpc("pane.send_text", { pane_id: codexPane, text: `clear; printf '%s\\n' '  >_ OpenAI Codex (v0.163.0)' '' '› Ask Codex to do anything' '' '  GPT-6.1-Sol low · /tmp/project'\n` });
  process.env["HOME"] = root;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome: join(root, ".codex") });
});

afterAll(async () => {
  server?.stop();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

const read = async (paneId: string): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

/**
 * The pane's answer once its model is `model`, polled under a deadline: a real herdr pane draws
 * its screen some time after the input, and nothing signals when.
 */
const readUntil = async (paneId: string, model: string): Promise<ConversationResponse> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const answer = await read(paneId);
    if (answer.metadata?.model === model || Date.now() > deadline) return answer;
    await Bun.sleep(50);
  }
};

it("states the model an unwritten omp session's status line draws, and follows a switch there", async () => {
  expect(await readUntil(ompPane, "gpt-6.1-sol")).toMatchObject({
    source: "omp-transcript", turns: [], screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" },
  });
  await herdrRpc("pane.send_text", { pane_id: ompPane, text: "s" });
  expect((await readUntil(ompPane, "claude-opus-5-5")).metadata).toEqual({ model: "claude-opus-5-5", reasoning_effort: "high" });
});

it("carries the model a Codex without a session states with the scrollback standing in", async () => {
  expect(await readUntil(codexPane, "gpt-6.1-sol")).toEqual({
    source: "scrollback", turns: [], screen: true, metadata: { model: "gpt-6.1-sol", reasoning_effort: "low" },
  });
});
