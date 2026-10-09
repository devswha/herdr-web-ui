import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePaneLayoutRequest } from "./pane-layout.ts";
import { paneFocus, paneResize, paneSplit, paneZoom } from "./herdr/client.ts";
import { demoPaneLayout } from "../site/demo/pane-layout.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import machines from "../site/demo/fixtures/machines.json";

it("rejects invalid layout requests before any RPC", async () => {
  for (const operation of ["split", "focus", "zoom", "resize"]) {
    for (const body of [null, [], 42, "body"]) {
      const response = await handlePaneLayoutRequest(new Request(`http://localhost/api/pane/${operation}`, { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_body" } });
    }
    const response = await handlePaneLayoutRequest(new Request(`http://localhost/api/pane/${operation}`, { method: "POST", body: "{}" }));
    expect(await response.json()).toMatchObject({ error: { code: "missing_pane_id" } });
  }
  for (const [operation, fields, code] of [
    ["split", { direction: "up" }, "invalid_direction"],
    ["zoom", { mode: "fullscreen" }, "invalid_mode"],
    ["resize", { direction: "sideways", amount: 0.1 }, "invalid_direction"],
    ["resize", { direction: "right", amount: 0 }, "invalid_amount"],
    ["resize", { direction: "right", amount: 0.81 }, "invalid_amount"],
  ] as const) {
    const response = await handlePaneLayoutRequest(new Request(`http://localhost/api/pane/${operation}`, {
      method: "POST", body: JSON.stringify({ pane_id: "owned", ...fields }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
  }
});

it("sends native operations on separate connections with the explicit target and no takeover", async () => {
  const root = mkdtempSync(join(tmpdir(), "layout-rpc-"));
  const socketPath = join(root, "herdr.sock");
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let connections = 0;
  const server = Bun.listen<{ buffer: string }>({
    unix: socketPath,
    socket: {
      open(socket) { connections++; socket.data = { buffer: "" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer);
        requests.push({ method: request.method, params: request.params });
        socket.end(JSON.stringify({ id: request.id, result: request.method === "pane.split" ? { type: "pane_info", pane: { pane_id: "new-pane" } } : { ok: true } }) + "\n");
      },
    },
  });
  try {
    expect((await paneSplit("remote-pane", "down", socketPath)).pane.pane_id).toBe("new-pane");
    await paneFocus("remote-pane", socketPath);
    await paneResize("remote-pane", "right", 0.2, socketPath);
    await paneZoom("remote-pane", "toggle", socketPath);
    expect(requests).toEqual([
      { method: "pane.split", params: { target_pane_id: "remote-pane", direction: "down", focus: false } },
      { method: "pane.focus", params: { pane_id: "remote-pane" } },
      { method: "pane.resize", params: { pane_id: "remote-pane", direction: "right", amount: 0.2 } },
      { method: "pane.zoom", params: { pane_id: "remote-pane", mode: "toggle" } },
    ]);
    expect(connections).toBe(4);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});

it("demo split, resize, focus and zoom change the same fictional native layout", () => {
  const snapshot: SessionSnapshot = structuredClone(machines.machines[0]!.snapshot);
  const pane = snapshot.panes[0]!;
  snapshot.layouts = [];
  const originalCount = snapshot.panes.length;
  expect(demoPaneLayout(snapshot, "split", { pane_id: pane.pane_id, direction: "right" }, "new").body).toEqual({ pane_id: "new" });
  expect(snapshot.panes).toHaveLength(originalCount + 1);
  expect(snapshot.layouts[0]?.panes.map((cell) => cell.rect.width)).toEqual([60, 60]);
  demoPaneLayout(snapshot, "resize", { pane_id: pane.pane_id, direction: "right", amount: 0.2 }, "unused");
  expect(snapshot.layouts[0]?.panes.map((cell) => cell.rect.width)).toEqual([84, 36]);
  demoPaneLayout(snapshot, "focus", { pane_id: "new" }, "unused");
  expect(snapshot.focused_pane_id).toBe("new");
  demoPaneLayout(snapshot, "zoom", { pane_id: "new", mode: "on" }, "unused");
  expect(snapshot.layouts[0]?.zoomed).toBe(true);
  expect(snapshot.layouts[0]?.focused_pane_id).toBe("new");
  expect(snapshot.panes.find((entry) => entry.pane_id === "new")?.workspace_id).toBe(pane.workspace_id);
});
