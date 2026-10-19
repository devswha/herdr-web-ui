import { expect, it, spyOn } from "bun:test";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import * as windows from "./windows-processes.ts";
import { forgetGjcState } from "./gjc-runtime.ts";

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
