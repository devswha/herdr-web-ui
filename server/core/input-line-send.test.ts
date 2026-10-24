import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

afterEach(() => mock.restore());

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

/** #1174's example: one line of 24 sentences, which typed raw reached Claude Code as only its tail */
const LONG = Array.from({ length: 24 }, (_, i) => `This is sentence number ${i + 1} of a long dictated message.`).join(" ");

const herdr = () => ({
  prompt: spyOn(client, "agentPrompt").mockResolvedValue(),
  typed: spyOn(client, "paneSendText").mockResolvedValue(),
  keys: spyOn(client, "paneSendKeys").mockResolvedValue(),
});

it("sends one long input line to the pane's agent as its prompt, not typed raw", async () => {
  const { prompt, typed, keys } = herdr();
  await submitter()("w:p1", LONG, LONG, Date.now(), true);
  expect(prompt).toHaveBeenCalledWith("w:p1", LONG);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});

it("still types a short input line, an answer into an open menu included", async () => {
  const { prompt, typed, keys } = herdr();
  await submitter()("w:p1", "2", "2", Date.now(), true);
  expect(prompt).not.toHaveBeenCalled();
  expect(typed).toHaveBeenCalledWith("w:p1", "2");
  expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"]);
});

for (const code of ["agent_not_found", "agent_not_ready", "agent_blocked"]) {
  it(`types a long input line as before when herdr refuses its prompt with ${code}`, async () => {
    const { prompt, typed, keys } = herdr();
    prompt.mockRejectedValue(new client.HerdrError(code, "fixture refusal"));
    await submitter()("w:p1", LONG, LONG, Date.now(), true);
    expect(typed).toHaveBeenCalledWith("w:p1", LONG);
    expect(keys).toHaveBeenCalledWith("w:p1", ["Enter"]);
  });
}

it("never types a long input line after its prompt failed in a way that may have delivered it", async () => {
  const { prompt, typed, keys } = herdr();
  prompt.mockRejectedValue(new client.HerdrError("timeout", "herdr did not answer"));
  const failed = await submitter()("w:p1", LONG, LONG, Date.now(), true).then(() => null, (error: unknown) => error);
  expect(failed).toBeInstanceOf(client.HerdrError);
  expect(typed).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});
