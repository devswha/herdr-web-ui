import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("socket lifecycle changes reach WebSocket clients", () => {
  let app: ReturnType<typeof createServer>;
  let workspace: Awaited<ReturnType<typeof workspaceCreate>>;
  let ws: WebSocket;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-collector-contract-"));

  function nextFrame(type: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMessage);
        reject(new Error(`No ${type} frame within 1000 ms`));
      }, 1000);
      function onMessage(event: MessageEvent) {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== type) return;
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
    if (workspace) await workspaceClose(workspace.workspace.workspace_id);
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
});
