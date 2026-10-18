import { expect, it, spyOn } from "bun:test";
import * as commands from "./commands.ts";
import * as conversation from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";

it("routes a Pi-labeled pane to OmO commands when its OmO roots are unavailable", async () => {
  const paneGet = spyOn(herdr, "paneGet").mockResolvedValue({ cwd: "C:\\repo", foreground_cwd: "C:\\repo", agent: "pi" } as never);
  const roots = spyOn(conversation, "paneProcessRoots").mockResolvedValue({ omo: null, environ: null, pid: null, cwd: null });
  const omo = spyOn(conversation, "paneRunsOmo").mockResolvedValue(true);
  const paneCommands = spyOn(commands, "paneCommands").mockReturnValue([]);
  try {
    const url = new URL("http://localhost/api/pane/commands?pane_id=windows-fixture");
    const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ commands: [] });
    expect(roots).toHaveBeenCalledWith("windows-fixture", "pi", "C:\\repo");
    expect(omo).toHaveBeenCalledWith("windows-fixture", "C:\\repo");
    expect(paneCommands).toHaveBeenCalledWith("omo", "C:\\repo", undefined, { environ: null });
  } finally {
    paneCommands.mockRestore();
    omo.mockRestore();
    roots.mockRestore();
    paneGet.mockRestore();
  }
});
