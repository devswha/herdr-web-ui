import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationHistory, type ConversationHistoryRuntime } from "./conversation-history.ts";
import { ConversationUnavailable } from "./conversation.ts";
import { createServer } from "./index.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import type { ConversationHistoryResponse } from "../shared/conversation-history.ts";

it("serves a durable library through authenticated read and explicit resume routes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-history-api-")));
  const cwd = join(root, "project"), omoHome = join(root, "omo"), stateDir = join(root, "state");
  mkdirSync(cwd);
  const sessions = join(omoHome, "sessions", `-${cwd.replaceAll("/", "-")}--`);
  mkdirSync(sessions, { recursive: true });
  const transcript = join(sessions, "2026-10-08T00-00-00-000Z_history-api.jsonl");
  writeFileSync(transcript, [
    { type: "session", version: 3, id: "history-api", cwd, timestamp: "2026-10-08T00:00:00Z" },
    { type: "session_info", name: "Saved API conversation" },
    { type: "message", id: "message-one", message: { role: "user", content: [{ type: "text", text: "SAVED_API_MESSAGE" }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const starts: string[][] = [];
  let created = 0;
  let running = false;
  const runtime: ConversationHistoryRuntime = {
    snapshot: async () => ({ agents: [], panes: running ? [{
      pane_id: "history-pane", workspace_id: "history-workspace", terminal_id: "history-terminal", tab_id: "history-tab",
      cwd, agent: "omo", agent_status: "idle", focused: false, revision: 1,
    }] : [], tabs: [], workspaces: [], layouts: [], protocol: 22, version: "test" }),
    resolve: async (pane) => {
      if (!running || pane.pane_id !== "history-pane") throw new ConversationUnavailable("no_session_path");
      return { source: "omo-transcript", path: transcript };
    },
    create: async () => { created++; return { pane_id: "history-pane", workspace_id: "history-workspace", terminal_id: "history-terminal" }; },
    start: async (_pane, args) => { starts.push(args); running = true; },
    close: async () => {},
    bootIdentity: () => "api-boot",
    processInfo: async () => ({ shell_pid: 1, foreground_processes: [{ pid: 1, argv: ["/bin/zsh"] }] }),
    inputIdle: async () => true,
  };
  const history = new ConversationHistory({ stateDir, omoHome, runtime, socketPath: herdrSocketPath() });
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "history-api-token", stateDir, conversationHistory: history, machines: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer history-api-token" };
  try {
    expect((await fetch(`${origin}/api/conversations`)).status).toBe(401);
    const listed = await fetch(`${origin}/api/conversations`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const body: ConversationHistoryResponse = await listed.json();
    const record = body.conversations[0];
    if (!record) throw new Error("Missing saved conversation");
    expect(record).toMatchObject({ title: "Saved API conversation", state: "closed", can_resume: true });
    const detail = await fetch(`${origin}/api/conversations/${record.id}`, { headers: auth });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ source: "omo-transcript", turns: [{ parts: [{ kind: "text", text: "SAVED_API_MESSAGE" }] }] });
    expect(created).toBe(0);
    expect((await fetch(`${origin}/api/conversations/${"0".repeat(64)}`, { headers: auth })).status).toBe(404);
    const resume = `${origin}/api/conversations/${record.id}/resume`;
    expect((await fetch(resume, { method: "POST", headers: auth })).status).toBe(403);
    expect((await fetch(resume, { method: "POST", headers: { ...auth, "x-herdr-machine": "1", origin: "https://unrelated.example" } })).status).toBe(403);
    expect(created).toBe(0);
    const responses = await Promise.all([
      fetch(resume, { method: "POST", headers: { ...auth, "x-herdr-machine": "1" } }),
      fetch(resume, { method: "POST", headers: { ...auth, "x-herdr-machine": "1" } }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(created).toBe(1);
    expect(starts).toEqual([["--session", transcript]]);
    server.stop();
    const restored = new ConversationHistory({ stateDir, omoHome, runtime, socketPath: herdrSocketPath() });
    expect((await restored.list()).map((entry) => entry.id)).toEqual([record.id]);
    expect((await restored.read(record.id)).turns[0]?.parts[0]).toEqual({ kind: "text", text: "SAVED_API_MESSAGE" });
    restored.stop();
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
