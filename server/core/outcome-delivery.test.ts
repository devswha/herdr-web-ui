import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as commands from "../commands.ts";
import { createSubmitText } from "./composer.ts";
import { prepareCommandSend } from "../prompt.ts";
import { commandOutcome } from "../outcome.ts";

afterEach(() => mock.restore());

const pane = { pane_id: "delivery-fixture", workspace_id: "w", tab_id: "t", terminal_id: "terminal",
  cwd: "/fixture", focused: false, revision: 0, agent: "pi", agent_status: "idle" };
const roots = { omo: null, environ: null, pid: null, cwd: null };
const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

for (const dependency of ["process-info", "transcript", "catalog", "snapshot"] as const) {
  for (const failure of ["slow", "failing"] as const) {
    it(`delivers before ${failure} ${dependency} outcome discovery can affect its deadline`, async () => {
      let now = 10_000;
      spyOn(Date, "now").mockImplementation(() => now);
      spyOn(client, "paneGet").mockResolvedValue(pane);
      const delivered = spyOn(client, "agentPrompt").mockResolvedValue();
      const processInfo = spyOn(conversation, "paneProcessRoots").mockResolvedValue(roots);
      spyOn(conversation, "paneTranscript").mockRejectedValue(new Error("fixture: no native binding"));
      const transcript = spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
      const catalog = spyOn(commands, "paneCommands").mockReturnValue([]);
      const screen = { ...pane, text: "", source: "detection" as const, format: "text" as const, truncated: false };
      const snapshot = spyOn(client, "paneRead").mockResolvedValue(screen);
      const disrupt = () => {
        if (failure === "failing") throw new Error(`fixture: ${dependency} failed`);
        now += 2000;
      };
      if (dependency === "process-info") processInfo.mockImplementation(async () => { disrupt(); return roots; });
      if (dependency === "transcript") transcript.mockImplementation(async () => { disrupt(); return null; });
      if (dependency === "catalog") catalog.mockImplementation(() => { disrupt(); return []; });
      if (dependency === "snapshot") snapshot.mockImplementation(async () => {
        disrupt(); return screen;
      });
      const result = await submitter()(pane.pane_id, "/myext", "/myext", now).then(() => "delivered", (error: unknown) => error);
      expect(result).toBe("delivered");
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(now).toBe(10_000);
      const sent = prepareCommandSend(pane, "/myext");
      if (!sent) throw new Error("fixture command was not recorded");
      expect(commandOutcome(pane.pane_id, sent, { now: sent.at + 600_000 })).toMatchObject({ state: "unknown", evidence: [] });
    });
  }
}

it("delivers a terminal input-line command without requiring paneGet", async () => {
  const paneGet = spyOn(client, "paneGet").mockRejectedValue(new client.HerdrError("fixture_unavailable", "pane lookup failed"));
  const text = spyOn(client, "paneSendText").mockResolvedValue();
  const keys = spyOn(client, "paneSendKeys").mockResolvedValue();
  await submitter()(pane.pane_id, "/context", "/context", Date.now(), true);
  expect(text).toHaveBeenCalledWith(pane.pane_id, "/context");
  expect(keys).toHaveBeenCalledWith(pane.pane_id, ["Enter"]);
  expect(paneGet).not.toHaveBeenCalled();
});

it("uses an already discovered inline skill only for the same pane identity", () => {
  commands.rememberPaneCommands(pane, "omo", [{ name: "review", description: "", source: "skill", trigger: "$",
    forms: [{ match: "bare", interaction: "unknown" }] }]);
  expect(prepareCommandSend(pane, "Please use $review")?.invocations).toHaveLength(1);
  expect(prepareCommandSend({ ...pane, terminal_id: "replacement" }, "Please use $review")).toBeUndefined();
  expect(prepareCommandSend({ ...pane, cwd: "/different" }, "Please use $review")).toBeUndefined();
});
