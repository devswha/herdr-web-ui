import { expect, it } from "bun:test";
import { commandInvocations, commandOutcome } from "./outcome.ts";

for (const agent of ["pi", "omp", "gjc", "omo", "codex"]) {
  it(`does not give an automatic ${agent} compaction to /compact without its own echo`, () => {
    const at = Date.parse("2026-10-20T00:00:00Z");
    const sent = { id: "compact", at, agent, identity: "fixture", text: "/compact", screen: "", form: null,
      invocations: commandInvocations(agent, "/compact", []) };
    const entry = (offset: number, value: object) => JSON.stringify({ timestamp: new Date(at + offset).toISOString(), ...value });
    const compaction = entry(10, { type: agent === "codex" ? "compacted" : "compaction" });
    expect(commandOutcome("pane", sent, { now: at + 100, transcript: compaction })).toMatchObject({ state: "accepted", evidence: [] });
    const echo = entry(5, agent === "codex"
      ? { type: "event_msg", payload: { type: "user_message", message: "/compact" } }
      : { type: "message", message: { role: "user", content: [{ type: "text", text: "/compact" }] } });
    expect(commandOutcome("pane", sent, { now: at + 100, transcript: `${echo}\n${compaction}` })).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
    expect(commandOutcome("pane", sent, { now: at + 100, transcript: `${compaction}\n${echo}` })).toMatchObject({ state: "accepted", evidence: [] });
  });
}
