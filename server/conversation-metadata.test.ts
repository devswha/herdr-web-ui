import { describe, expect, it } from "bun:test";
import { parseConversationMetadata } from "./conversation-metadata.ts";

const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

describe("recorded conversation model settings", () => {
  it("uses the latest Codex turn context, not the session's initial model", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "session_meta", payload: { model: "initial", reasoning_effort: "low" } },
      { type: "turn_context", payload: { model: "current", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "user", model: "user text is not metadata" } },
    ), "codex-transcript")).toEqual({ model: "current", reasoning_effort: "xhigh" });
  });

  it("recognizes collaboration-mode settings and explicit effort overrides", () => {
    const context = { collaboration_mode: { settings: { model: "collaboration-model", reasoning_effort: "high" } } };
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: context }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "high" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: "none" } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "none" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: null } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: null });
  });

  it("does not carry an old effort into a Codex context that no longer reports one", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "turn_context", payload: { model: "first", effort: "high" } },
      { type: "turn_context", payload: { model: "second" } },
    ), "codex-transcript")).toEqual({ model: "second", reasoning_effort: null });
  });

  it("updates independent omp/omo model and thinking settings, including off", () => {
    for (const source of ["omp-transcript", "omo-transcript"] as const) {
      expect(parseConversationMetadata(jsonl(
        { type: "model_change", modelId: "first" },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "model_change", modelId: "second" },
      ), source)).toEqual({ model: "second", reasoning_effort: "max" });
      expect(parseConversationMetadata(jsonl(
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", model: "actual-response-model" } },
      ), source)).toEqual({ model: "actual-response-model", reasoning_effort: "off" });
    }
  });

  it("reads Claude's actual model without deriving effort from thinking content", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "text" }] } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: null });
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", effort: "xhigh", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: "xhigh" });
  });

  it("tolerates absent metadata, unexpected types and a torn append without losing valid settings", () => {
    const text = jsonl(null, [], { type: "turn_context", payload: null },
      { type: "turn_context", payload: { model: "recorded", effort: "medium" } },
      { type: "turn_context", payload: { model: {}, effort: undefined } });
    expect(parseConversationMetadata(`${text}\n{"type":`, "codex-transcript"))
      .toEqual({ model: "recorded", reasoning_effort: "medium" });
    expect(parseConversationMetadata("", "scrollback")).toEqual({ model: null, reasoning_effort: null });
  });
});

describe("context use", () => {
  const assistant = (usage: Record<string, number>, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) =>
    ({ type: "assistant", ...extra, message: { role: "assistant", model, usage } });

  it("reads Codex's last request against the window it states", () => {
    const tokens = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
    expect(parseConversationMetadata(jsonl(tokens(10_000), tokens(67_723), { type: "event_msg", payload: { type: "token_count", info: null } }), "codex-transcript").context)
      .toEqual({ used: 67_723, window: 258_400 });
  });

  it("adds up a Claude request's input and cache, skipping subagents, and knows the 1M window once past 200k", () => {
    const small = parseConversationMetadata(jsonl(assistant({ input_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 40_000, output_tokens: 900 })), "claude-transcript");
    expect(small.context).toEqual({ used: 40_702, window: null });
    const long = parseConversationMetadata(jsonl(
      assistant({ input_tokens: 5, cache_read_input_tokens: 420_000 }),
      assistant({ input_tokens: 1, cache_read_input_tokens: 5_000 }, "claude-opus-5-5", { isSidechain: true }),
      // compacted: the use shrinks, the window stays
      assistant({ input_tokens: 3, cache_read_input_tokens: 30_000 }),
      assistant({ input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
    ), "claude-transcript");
    expect(long.context).toEqual({ used: 30_003, window: 1_000_000 });
  });

  it("reads omp's usage shape, with no window to go by", () => {
    const entry = { type: "message", message: { role: "assistant", model: "gpt-6", usage: { input: 2, output: 7_000, cacheRead: 10_000, cacheWrite: 22_000 } } };
    expect(parseConversationMetadata(jsonl(entry), "omo-transcript").context).toEqual({ used: 32_002, window: null });
    expect(parseConversationMetadata(jsonl({ type: "message", message: { role: "user" } }), "omp-transcript").context).toBeUndefined();
  });
});
