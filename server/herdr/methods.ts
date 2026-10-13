import type { AgentInfo, AgentTarget, PaneProcessInfo, PaneProcessInfoParams, PaneSendKeysParams, PaneSendTextParams } from "../../shared/herdr-api.generated.ts";

/**
 * The herdr methods `herdrRpc` knows the shape of: each method's params and its raw answer
 * (the envelope; the wrappers in client.ts unwrap it). Add a method here, with a wrapper in
 * client.ts, before calling it from outside server/herdr/.
 *
 * Hand-written on purpose: herdr's schema maps a method to its params (`request.oneOf`), but its
 * answers are one `ResponseResult.oneOf` told apart by a `type` tag (`pane_process_info`,
 * `agent_info`, `ok`) with no link back to the method, so a generated method -> result table
 * would be a hand-kept table anyway. The params and result bodies come from the generated types
 * (scripts/generate-protocol-types.ts ROOTS).
 */
export interface HerdrMethods {
  /** `pane_id`, never `target`: given `target`, herdr silently answers for the focused pane. */
  "pane.process_info": { params: PaneProcessInfoParams & { pane_id: string }; result: { type?: "pane_process_info"; process_info?: PaneProcessInfo } };
  "agent.get": { params: AgentTarget; result: { type?: "agent_info"; agent: AgentInfo } };
  "pane.send_text": { params: PaneSendTextParams; result: { type?: "ok" } };
  "pane.send_keys": { params: PaneSendKeysParams; result: { type?: "ok" } };
}

export type HerdrMethod = keyof HerdrMethods;

/**
 * A method `HerdrMethods` does not type yet. A typed method given here is `never`, so a call
 * like `herdrRpc("pane.process_info", { target })` fails to compile instead of falling back.
 */
export type UntypedHerdrMethod<M extends string> = M extends HerdrMethod ? never : M;
