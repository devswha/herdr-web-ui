import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { startStatusCollector } from "./collector.ts";
import { createServer } from "./index.ts";
import { herdrRpc, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("socket lifecycle changes reach WebSocket clients", () => {
  let app: ReturnType<typeof createServer>;
  let workspace: Awaited<ReturnType<typeof workspaceCreate>>;
  let ws: WebSocket;
  let movedWorkspace: string | undefined;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-collector-contract-"));

  function nextFrame(type: string, matches: (frame: ServerMessage) => boolean = () => true, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`No matching ${type} frame within ${timeoutMs} ms`));
      }, timeoutMs);
      function onMessage(event: MessageEvent) {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== type || !matches(frame)) return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      }
      ws.addEventListener("message", onMessage);
    });
  }

  beforeAll(async () => {
    workspace = await workspaceCreate({ cwd: stateDir, label: "herdr-web-ui-test-collector-lifecycle" });
    app = createServer({ port: 0, stateDir });
    await app.statusReady;
    ws = new WebSocket(`ws://localhost:${app.port}/ws`);
    await nextFrame("snapshot");
  });

  afterAll(async () => {
    ws?.close();
    app?.stop();
    if (movedWorkspace) await workspaceClose(movedWorkspace);
    else if (workspace) await workspaceClose(workspace.workspace.workspace_id);
    rmSync(stateDir, { recursive: true, force: true });
  });

  for (const method of ["workspace.rename", "tab.rename", "pane.zoom"]) {
    it(`pushes session-changed within one second after ${method} over the socket`, async () => {
      const params = method === "workspace.rename"
        ? { workspace_id: workspace.workspace.workspace_id, label: "collector-renamed-workspace" }
        : method === "tab.rename"
          ? { tab_id: workspace.tab.tab_id, label: "collector-renamed-tab" }
          : { pane_id: workspace.root_pane.pane_id, mode: "on" };
      const changed = nextFrame("session-changed");
      const started = performance.now();
      await herdrRpc(method, params);
      await changed;
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }

  it("tells browsers of a completion after a working pane moves before reconciliation", async () => {
    const working = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.agent_status === "working");
    await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
    await working;
    const completed = nextFrame("pane-status", (frame) => frame.type === "pane-status" && frame.pane_id !== workspace.root_pane.pane_id && frame.agent_status === "done", 2000);
    const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
      pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "herdr-web-ui-test-moved-completion" }, focus: false,
    });
    movedWorkspace = move_result.pane.workspace_id;
    await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
    await completed;
  });
});

describe("completion replay across a moved subscription key", () => {
  it("replays the finish on the new ID when its status stream has not subscribed yet", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-test-moved-gap-"));
    const workspace = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-moved-gap" });
    let workspaceId = workspace.workspace.workspace_id;
    const statuses: { paneId: string; before: string | undefined }[] = [];
    const working = Promise.withResolvers<void>();
    let reconciled = Promise.withResolvers<void>();
    const collector = startStatusCollector({
      onStatus(paneId, status, _agent, replay) {
        statuses.push({ paneId, before: replay?.before });
        if (paneId === workspace.root_pane.pane_id && status === "working") working.resolve();
      },
      onBaseline() {},
      onPaneEnded() {},
      onStructureChange() {},
      onReconciled(panes) {
        if (panes.some((pane) => pane.workspace_id === workspaceId && pane.agent_status !== "working")) reconciled.resolve();
      },
    }, {
      subscribe(subs, handlers, ...rest) {
        const subscribedIds = new Set(subs.flatMap((sub) => "pane_id" in sub ? [sub.pane_id] : []));
        return subscribeEvents(subs, {
          ...handlers,
          onEvent(frame) {
            // Model the known move gap: a stream opened for the old ID gives no
            // guarantee of delivery for the new ID until the collector reopens it.
            if (frame.event === "pane.agent_status_changed") {
              const data = frame.data as { pane_id: string };
              if (!subscribedIds.has(data.pane_id)) return;
            }
            handlers.onEvent(frame);
          },
        }, ...rest);
      },
    });
    try {
      await collector.ready;
      await herdrRpc("pane.report_agent", { pane_id: workspace.root_pane.pane_id, source: "manual", agent: "codex", state: "working" });
      await working.promise;
      const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string; workspace_id: string } } }>("pane.move", {
        pane_id: workspace.root_pane.pane_id, destination: { type: "new_workspace", label: "herdr-web-ui-test-moved-gap" }, focus: false,
      });
      workspaceId = move_result.pane.workspace_id;
      statuses.length = 0;
      reconciled = Promise.withResolvers<void>();
      await herdrRpc("pane.report_agent", { pane_id: move_result.pane.pane_id, source: "manual", agent: "codex", state: "idle" });
      await reconciled.promise;
      expect(statuses).toEqual([{ paneId: move_result.pane.pane_id, before: "working" }]);
    } finally {
      collector.stop();
      await workspaceClose(workspaceId);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
