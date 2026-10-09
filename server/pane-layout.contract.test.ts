import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { workspaceCreate, workspaceClose, sessionSnapshot } from "./herdr/client.ts";
import { UsageService } from "./usage.ts";
import type { PaneSplit } from "../shared/protocol.ts";

it("splits, resizes, focuses and zooms only an owned pane through the HTTP contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-layout-contract-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state"), token: "", usage: new UsageService(undefined, []) });
  let workspace: string | undefined;
  const post = (operation: string, body: object, local = false) => fetch(`http://127.0.0.1:${server.port}/api/${local ? "machines/local/" : ""}pane/${operation}`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body),
  });
  try {
    const owned = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-multi-pane" });
    workspace = owned.workspace.workspace_id;
    const first = owned.root_pane.pane_id;
    const split = await post("split", { pane_id: first, direction: "right" });
    expect(split.status).toBe(200);
    const second = (await split.json() as PaneSplit).pane_id;
    expect(typeof second).toBe("string");
    expect((await post("focus", { pane_id: second }, true)).status).toBe(200);
    expect((await sessionSnapshot()).focused_pane_id).toBe(second);
    expect((await post("resize", { pane_id: first, direction: "right", amount: 0.1 })).status).toBe(200);
    let layout = (await sessionSnapshot()).layouts.find((entry) => entry.tab_id === owned.root_pane.tab_id);
    expect(layout?.panes).toHaveLength(2);
    expect(layout?.splits[0]?.ratio).toBeCloseTo(0.6);
    expect((await post("zoom", { pane_id: second, mode: "on" })).status).toBe(200);
    layout = (await sessionSnapshot()).layouts.find((entry) => entry.tab_id === owned.root_pane.tab_id);
    expect(layout?.zoomed).toBe(true);
    expect(layout?.panes.map((pane) => pane.pane_id).sort()).toEqual([first, second].sort());
    expect((await post("zoom", { pane_id: second, mode: "off" })).status).toBe(200);
  } finally {
    try { if (workspace) await workspaceClose(workspace); }
    finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  }
}, 30_000);
