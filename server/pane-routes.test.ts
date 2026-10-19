import { expect, it, spyOn } from "bun:test";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import * as windows from "./windows-processes.ts";
import { forgetGjcState } from "./gjc-runtime.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as omo from "./omo.ts";

it("keeps foreground Pi commands when a background OmO is its sibling", async () => {
  const platform = process.platform;
  forgetGjcState();
  const paneGet = spyOn(herdr, "paneGet").mockResolvedValue({ cwd: "C:\\repo", agent: "pi" } as never);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: {
    shell_pid: 10, foreground_processes: [{ pid: 11, argv: ["C:\\tools\\pi.exe"] }],
  } } as never);
  const table = spyOn(windows, "windowsProcessTable").mockResolvedValue([
    { pid: 10, parent: 1, path: "C:\\pwsh.exe", commandLine: "pwsh.exe", started: 1000 },
    { pid: 11, parent: 10, path: "C:\\tools\\pi.exe", commandLine: "pi.exe", started: 2000 },
    { pid: 12, parent: 10, path: "C:\\tools\\omo.exe", commandLine: "omo.exe", started: 3000 },
  ]);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const url = new URL("http://localhost/api/pane/commands?pane_id=foreground-pi");
    const response = await handlePaneRequest(new Request(url), url, url.pathname, {});
    const body = await response?.json();
    expect(response?.status).toBe(200);
    expect(body.commands.some((command: { name: string }) => command.name === "bug")).toBeTrue();
    expect(body.commands.some((command: { name: string }) => command.name === "favorite-models")).toBeFalse();
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    table.mockRestore();
    rpc.mockRestore();
    paneGet.mockRestore();
    forgetGjcState();
  }
});

it("rejects a same argv reused foreground PID now owned by another shell", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-omo-foreign-pid-"));
  const agentDir = join(cwd, "agent");
  const pid = 2 ** 30;
  const holders = join(agentDir, "sessions", omo.omoSessionFolder(cwd), "session-holders", "foreign-session");
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, cwd, processStartedAtMs: 20_000 }));
  const platform = process.platform;
  forgetGjcState();
  const paneGet = spyOn(herdr, "paneGet").mockResolvedValue({ cwd, agent: "pi" } as never);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: {
    shell_pid: 10, foreground_processes: [{ pid, argv: ["C:\\tools\\pi.exe"], cwd }],
  } } as never);
  const table = spyOn(windows, "windowsProcessTable").mockResolvedValue([
    { pid: 10, parent: 1, path: "C:\\pwsh.exe", commandLine: "pwsh.exe", started: 1000 },
    { pid: 20, parent: 1, path: "C:\\pwsh.exe", commandLine: "pwsh.exe", started: 2000 },
    { pid, parent: 20, path: "C:\\tools\\pi.exe", commandLine: "pi.exe", started: 20_000 },
  ]);
  const environ = spyOn(omo, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const url = new URL("http://localhost/api/pane/commands?pane_id=foreign-pid");
    const response = await handlePaneRequest(new Request(url), url, url.pathname, {});
    const body = await response?.json();
    expect(response?.status).toBe(200);
    expect(body.commands.some((command: { name: string }) => command.name === "bug")).toBeTrue();
    expect(body.commands.some((command: { name: string }) => command.name === "favorite-models")).toBeFalse();
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    environ.mockRestore();
    table.mockRestore();
    rpc.mockRestore();
    paneGet.mockRestore();
    forgetGjcState();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("keeps real Pi commands after one failed Windows listing per request", async () => {
  const platform = process.platform;
  forgetGjcState();
  const paneGet = spyOn(herdr, "paneGet").mockResolvedValue({ cwd: "C:\\repo", agent: "pi" } as never);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: {
    shell_pid: 10, foreground_processes: [{ pid: 11, argv: ["C:\\tools\\pi.exe"] }],
  } } as never);
  const table = spyOn(windows, "windowsProcessTable").mockResolvedValue([]);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const url = new URL("http://localhost/api/pane/commands?pane_id=real-pi");
    const response = await handlePaneRequest(new Request(url), url, url.pathname, {});
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.commands.some((command: { name: string }) => command.name === "new")).toBeTrue();
    expect(table).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    table.mockRestore();
    rpc.mockRestore();
    paneGet.mockRestore();
    forgetGjcState();
  }
});

it("routes a Pi-labeled Windows launcher to its verified OmO descendant commands", async () => {
  const platform = process.platform;
  forgetGjcState();
  const paneGet = spyOn(herdr, "paneGet").mockResolvedValue({ cwd: "C:\\repo", foreground_cwd: "C:\\repo", agent: "pi" } as never);
  const rpc = spyOn(herdr, "herdrRpc").mockResolvedValue({ process_info: {
    shell_pid: 10, foreground_processes: [{ pid: 11, argv: ["C:\\tools\\pi.exe"] }],
  } } as never);
  const table = spyOn(windows, "windowsProcessTable").mockResolvedValue([
    { pid: 10, parent: 1, path: "C:\\pwsh.exe", commandLine: "pwsh.exe", started: 1000 },
    { pid: 11, parent: 10, path: "C:\\tools\\pi.exe", commandLine: "pi.exe", started: 2000 },
    { pid: 12, parent: 11, path: "C:\\tools\\omo.exe", commandLine: "omo.exe", started: 3000 },
  ]);
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const url = new URL("http://localhost/api/pane/commands?pane_id=windows-fixture");
    const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});

    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body.commands.some((command: { name: string }) => command.name === "favorite-models")).toBeTrue();
    expect(body.commands.some((command: { name: string }) => command.name === "bug")).toBeFalse();
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    table.mockRestore();
    rpc.mockRestore();
    paneGet.mockRestore();
    forgetGjcState();
  }
});
