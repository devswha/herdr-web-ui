import { describe, expect, test } from "bun:test";
import { modelLabel } from "./modelName.ts";

describe("modelLabel", () => {
  test("names a Claude id by the vendor's family and version", () => {
    expect(modelLabel("claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
    expect(modelLabel("claude-sonnet-5")).toEqual({ text: "Sonnet 5", named: true });
    expect(modelLabel("claude-haiku-4-5")).toEqual({ text: "Haiku 4.5", named: true });
    expect(modelLabel("claude-opus-4-1")).toEqual({ text: "Opus 4.1", named: true });
    expect(modelLabel("claude-fable-5-1")).toEqual({ text: "Fable 5.1", named: true });
  });

  test("reads the vendor's own provider prefix as the same model", () => {
    expect(modelLabel("anthropic/claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
  });

  test("names a bare GPT or GLM version", () => {
    expect(modelLabel("gpt-5.6")).toEqual({ text: "GPT-5.6", named: true });
    expect(modelLabel("gpt-6")).toEqual({ text: "GPT-6", named: true });
    expect(modelLabel("glm-5.3")).toEqual({ text: "GLM-5.3", named: true });
  });

  test("shows an id it cannot name for certain exactly as received", () => {
    for (const id of [
      // a dated snapshot: the date is not dropped
      "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]", "claude-opus-5-5-fast",
      // the older order of family and version, and a family the vendor does not list
      "claude-3-5-sonnet-20241022", "claude-3", "claude-nova-5",
      // tier and product words
      "gpt-5.6-sol", "gpt-5.6-sol-max", "gpt-5.6-sol-codex-preview-2026-10", "gpt-4.1-mini", "gpt-transcribe",
      // another provider's route, another vendor, and ids that only look close
      "bedrock/claude-opus-5-5", "openrouter/anthropic/claude-opus-5-5", "openai/gpt-5.6", "anthropic/x",
      "qwen-3-8-flash", "grok-4.7", "glm-5.3-air", "Claude-Opus-5-5", " claude-opus-5-5", "codex-test-model", "<synthetic>", "",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
  });
});
