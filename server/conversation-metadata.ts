import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim() && !value.startsWith("<") ? value.trim() : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Claude's standard window; a request past it can only have run in the 1M one. */
const CLAUDE_STANDARD_WINDOW = 200_000;
const CLAUDE_LONG_WINDOW = 1_000_000;

/**
 * The context a request filled, and the window when the transcript leaves no doubt. Only
 * Codex records its window; a Claude model is known to run in the 1M one once a request
 * went past 200k (and keeps it: a compaction shrinks the use, not the window).
 */
function contextOf(used: number, model: string | null, window: number | null, before: ConversationMetadata["context"]): ConversationMetadata["context"] {
  if (used === 0) return before;
  if (window !== null) return { used, window };
  const long = model?.startsWith("claude") && (used > CLAUDE_STANDARD_WINDOW || before?.window === CLAUDE_LONG_WINDOW);
  return { used, window: long ? CLAUDE_LONG_WINDOW : null };
}

/** Read recorded settings, never infer effort from the presence of thinking text.
 * Codex turn_context is a snapshot; omp/omo setting changes are separate events. */
export function parseConversationMetadata(text: string, source: ConversationResponse["source"], before?: ConversationMetadata): ConversationMetadata {
  // `before` is what the text preceding this one said: the fold picks up where it stopped
  const metadata: ConversationMetadata = before ? { ...before } : { model: null, reasoning_effort: null };
  for (const line of text.split("\n")) {
    let entry: RecordValue;
    try { entry = record(JSON.parse(line)); } catch { continue; }
    if (source === "codex-transcript") {
      const event = record(entry.payload);
      if (entry.type === "event_msg" && event.type === "token_count") {
        // what the last request filled, against the window Codex itself states
        const info = record(event.info);
        const window = count(info.model_context_window);
        metadata.context = contextOf(count(record(info.last_token_usage).total_tokens), metadata.model, window || null, metadata.context);
        continue;
      }
      if (entry.type !== "turn_context" && entry.type !== "session_meta") continue;
      const payload = record(entry.payload);
      const settings = record(record(payload.collaboration_mode).settings);
      const model = label(payload.model) ?? label(settings.model);
      const effort = "effort" in payload ? payload.effort
        : "reasoning_effort" in payload ? payload.reasoning_effort : settings.reasoning_effort;
      if (model) metadata.model = model;
      // A new complete context without effort must not retain an older value.
      if (model || effort !== undefined) metadata.reasoning_effort = label(effort);
    } else if (source === "omp-transcript" || source === "omo-transcript" || source === "gjc-transcript") {
      if (entry.type === "model_change") metadata.model = label(entry.modelId);
      if (entry.type === "thinking_level_change") metadata.reasoning_effort = label(entry.thinkingLevel);
      const message = record(entry.message);
      if (entry.type === "message" && message.role === "assistant" && label(message.model)) metadata.model = label(message.model);
      if (entry.type === "message" && message.role === "assistant") {
        const usage = record(message.usage);
        metadata.context = contextOf(count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite), metadata.model, null, metadata.context);
      }
    } else if (source === "claude-transcript") {
      const message = record(entry.message);
      if (entry.type === "assistant" && label(message.model)) metadata.model = label(message.model);
      // a subagent's request fills its own context, not this one's
      if (entry.type === "assistant" && entry.isSidechain !== true && label(message.model)) {
        const usage = record(message.usage);
        metadata.context = contextOf(count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens), metadata.model, null, metadata.context);
      }
      // Claude Code records the effort each response ran at; versions before it record none
      if (entry.type === "assistant" && "effort" in entry) metadata.reasoning_effort = label(entry.effort);
    }
  }
  return metadata;
}
