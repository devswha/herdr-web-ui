import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, herdrSocketPath, sessionSnapshot, workspaceClose, workspaceCreate, type WorkspaceCreateResult } from "./herdr/client.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";
import type { ApiError, PluginActionResult, PluginActionsResponse } from "../shared/protocol.ts";

/**
 * GET /api/plugins/actions and POST /api/plugin/action against a real herdr, with a plugin linked
 * for the test from a temp directory and unlinked after it.
 *
 * herdr keeps linked plugins per user, not per session (`$XDG_CONFIG_HOME/herdr/plugins.json`), so
 * this runs only on a herdr whose config is not the user's own: `bun run check` and CI give the
 * run a config directory of its own. On the shared `herdr-web-ui-test` session it is skipped
 * rather than writing a plugin into the registry of the herdr you work in.
 */
const ownConfig = !resolve(herdrSocketPath()).startsWith(resolve(homedir(), ".config", "herdr"));
const PLUGIN = "herdr-web-ui-test.actions";

describe.skipIf(!ownConfig || process.platform === "win32")("plugin actions API", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-plugin-"));
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-plugin-state-"));
  const marker = join(root, "marker.json");
  let server: { port: number; stop: () => void };
  let created: WorkspaceCreateResult;

  const base = () => `http://localhost:${server.port}`;
  const invoke = (body: unknown, headers: Record<string, string> = { "x-herdr-machine": "1" }) =>
    fetch(`${base()}/api/plugin/action`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    writeFileSync(join(root, "herdr-plugin.toml"), `id = "${PLUGIN}"
name = "Web UI test actions"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Linked by server/plugins.contract.test.ts"
platforms = ["linux", "macos", "windows"]

[[actions]]
id = "mark"
title = "Write marker"
description = "Writes its invocation context"
contexts = ["pane"]
command = ["sh", "mark.sh"]

[[actions]]
id = "fail"
title = "Always fails"
contexts = ["global"]
command = ["sh", "-c", "echo boom >&2; exit 3"]

[[actions]]
id = "board"
title = "Open board"
contexts = ["workspace"]
command = ["sh", "-c", "exec \\"$HERDR_BIN_PATH\\" plugin pane open --plugin ${PLUGIN} --entrypoint board --placement split --target-pane \\"$HERDR_PANE_ID\\" --focus"]
platforms = ["linux", "macos"]

[[actions]]
id = "elsewhere"
title = "Another platform"
contexts = ["global"]
command = ["true"]
platforms = ["${process.platform === "linux" ? "macos" : "linux"}"]

[[panes]]
id = "board"
title = "Test board"
placement = "split"
command = ["sh", "-c", "exec sleep 600"]
platforms = ["linux", "macos"]
`);
    writeFileSync(join(root, "mark.sh"), `printf '%s' "$HERDR_PLUGIN_CONTEXT_JSON" > marker.json.tmp && mv marker.json.tmp marker.json\n`);
    await herdrRpc("plugin.link", { path: root });
    created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-plugin-actions" });
    server = createServer({ port: 0, stateDir });
  });

  afterAll(async () => {
    server?.stop();
    if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    await herdrRpc("plugin.unlink", { plugin_id: PLUGIN }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists each plugin with its enabled state and the actions this platform can run, without their command lines", async () => {
    const response = await fetch(`${base()}/api/plugins/actions`);
    expect(response.status).toBe(200);
    const { plugins } = (await response.json()) as PluginActionsResponse;
    const plugin = plugins.find((entry) => entry.plugin_id === PLUGIN)!;
    expect(plugin).toEqual({
      plugin_id: PLUGIN,
      name: "Web UI test actions",
      version: "0.1.0",
      description: "Linked by server/plugins.contract.test.ts",
      enabled: true,
      actions: [
        { action_id: "board", title: "Open board", description: null, contexts: ["workspace"] },
        { action_id: "fail", title: "Always fails", description: null, contexts: ["global"] },
        { action_id: "mark", title: "Write marker", description: "Writes its invocation context", contexts: ["pane"] },
      ],
    });
  });

  it("runs an action with the named pane's workspace, tab and pane as its context, not herdr's focus", async () => {
    const paneId = created.root_pane.pane_id;
    // the workspace was made unfocused: herdr's own focus is another pane
    expect((await sessionSnapshot()).focused_pane_id).not.toBe(paneId);
    const response = await invoke({ plugin_id: PLUGIN, action_id: "mark", pane_id: paneId });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "succeeded", exit_code: 0, output: null, opened_pane_id: null } satisfies PluginActionResult);
    expect(existsSync(marker)).toBe(true);
    const context = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    expect(context).toMatchObject({
      workspace_id: created.workspace.workspace_id,
      workspace_label: "herdr-web-ui-test-plugin-actions",
      tab_id: created.tab.tab_id,
      tab_label: created.tab.label,
      focused_pane_id: paneId,
      invocation_source: "herdr-web-ui",
    });
  });

  it("answers a command that failed with its exit code and its own words", async () => {
    const response = await invoke({ plugin_id: PLUGIN, action_id: "fail" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed", exit_code: 3, output: "boom", opened_pane_id: null } satisfies PluginActionResult);
  });

  // the action itself says where its pane goes: herdr's `plugin pane open` uses herdr's focus unless told
  it("names the pane an action opened and focused", async () => {
    const before = (await sessionSnapshot()).panes.map((pane) => pane.pane_id);
    const response = await invoke({ plugin_id: PLUGIN, action_id: "board", pane_id: created.root_pane.pane_id });
    expect(response.status).toBe(200);
    const result = (await response.json()) as PluginActionResult;
    expect(result.status).toBe("succeeded");
    expect(result.opened_pane_id).not.toBeNull();
    expect(before).not.toContain(result.opened_pane_id!);
    const opened = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === result.opened_pane_id);
    expect(opened?.workspace_id).toBe(created.workspace.workspace_id);
  });

  it("refuses what it cannot run with herdr's own code, and a pane that is not there", async () => {
    const cases: [unknown, number, string][] = [
      [{ plugin_id: PLUGIN, action_id: "nope" }, 404, "plugin_action_not_found"],
      [{ plugin_id: "herdr-web-ui-test.none", action_id: "mark" }, 404, "plugin_not_found"],
      [{ plugin_id: PLUGIN, action_id: "elsewhere" }, 404, "platform_unsupported"],
      [{ plugin_id: PLUGIN, action_id: "mark", pane_id: "w0:p0-gone" }, 404, "pane_not_found"],
      [{ plugin_id: PLUGIN }, 400, "missing_action_id"],
      [{ action_id: "mark" }, 400, "missing_plugin_id"],
      [{ plugin_id: PLUGIN, action_id: "mark", pane_id: 7 }, 400, "invalid_pane_id"],
      [[], 400, "invalid_body"],
    ];
    for (const [body, status, code] of cases) {
      const response = await invoke(body);
      expect([body, response.status]).toEqual([body, status]);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
    expect((await fetch(`${base()}/api/plugin/action`)).status).toBe(400);
    expect((await fetch(`${base()}/api/plugins/actions`, { method: "POST", headers: { "x-herdr-machine": "1" } })).status).toBe(400);
  });

  it("runs nothing for a page of another origin", async () => {
    rmSync(marker, { force: true });
    const response = await invoke({ plugin_id: PLUGIN, action_id: "mark", pane_id: created.root_pane.pane_id }, { origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ApiError).error.code).toBe("invalid_origin");
    expect(existsSync(marker)).toBe(false);
  });

  it("lists a disabled plugin as disabled and passes on herdr's refusal to run it", async () => {
    await herdrRpc("plugin.disable", { plugin_id: PLUGIN });
    try {
      const { plugins } = (await (await fetch(`${base()}/api/plugins/actions`)).json()) as PluginActionsResponse;
      const plugin = plugins.find((entry) => entry.plugin_id === PLUGIN)!;
      expect(plugin.enabled).toBe(false);
      expect(plugin.actions.map((action) => action.action_id)).toEqual(["board", "fail", "mark"]);
      const response = await invoke({ plugin_id: PLUGIN, action_id: "mark" });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe("plugin_disabled");
    } finally {
      await herdrRpc("plugin.enable", { plugin_id: PLUGIN });
    }
  });

  it("is forwarded to a remote PC's bridge", () => {
    expect(MACHINE_PROXY_PATH.test("plugins/actions")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("plugin/action")).toBe(true);
    expect(MACHINE_PROXY_PATH.test("plugin/link")).toBe(false);
  });
});
