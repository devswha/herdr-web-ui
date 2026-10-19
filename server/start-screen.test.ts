import { describe, expect, it } from "bun:test";

import type { OmpCatalogModel } from "./omp-catalog.ts";
import { readsStartScreen, startScreenMetadata } from "./start-screen.ts";

const CLAUDE = [
  " ▐▛███▛█   Claude Code v2.1.296",
  "▝▜██████▀  Haiku 5.5 · Claude Max",
  " ▝▝   ▝▝   ~/workspace/test-project",
  "────────────────────────────────────────",
  "❯ Try \"fix lint errors\"",
  "────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const CODEX = [
  "  >_ OpenAI Codex (v0.162.1)",
  "     /tmp/test-project",
  "  permissions: YOLO mode",
  "  /model - choose what model and reasoning effort to use",
  "› Ask Codex to do anything",
  "  GPT-6-Luna medium fast · /tmp/test-project",
  "  ← for agents · ? for shortcuts",
].join("\n");

const GJC = [
  "│                 [ ⬢ Anthropic Opus 5.5 ]                 │ ─────────────── │",
  "╰──────────────────────────────────────────────────────────┴─────────────────╯",
  " ⬢ opus-5.5 · ◉ xhigh · 1.5% / ⑂ main / 📁 …/test-project ───── (sub) / v0.17.7",
  "│ > Type your message... ⌥Q: Queue (busy) · ⇧⇥: Thinking │",
].join("\n");

describe("startScreenMetadata", () => {
  it("reads Claude Code's model under its title, as the id its transcript records", () => {
    expect(startScreenMetadata("claude-transcript", CLAUDE)).toEqual({ model: "claude-haiku-5-5", reasoning_effort: null });
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Sonnet 5"))).toEqual({ model: "claude-sonnet-5", reasoning_effort: null });
  });

  it("names no Claude model it cannot give an id for certain", () => {
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Opus 5.5 (1M context)")).model).toBeNull();
    expect(startScreenMetadata("claude-transcript", CLAUDE.replace("Haiku 5.5", "Default")).model).toBeNull();
    // the folder question stands where the title would: nothing says the model yet
    expect(startScreenMetadata("claude-transcript", "Accessing workspace\nIs this a project you created or one you trust?").model).toBeNull();
  });

  it("reads Codex's model and effort from the line under its composer", () => {
    expect(startScreenMetadata("codex-transcript", CODEX)).toEqual({ model: "gpt-6-luna", reasoning_effort: "medium" });
    expect(startScreenMetadata("codex-transcript", CODEX.replace("GPT-6-Luna medium fast", "GPT-5.6 xhigh"))).toEqual({ model: "gpt-5.6", reasoning_effort: "xhigh" });
  });

  it("reads nothing of a Codex screen without its header or its status line", () => {
    expect(startScreenMetadata("codex-transcript", "  GPT-6-Luna medium fast · /tmp/test-project")).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("codex-transcript", "  >_ OpenAI Codex (v0.162.1)\n  Trust this folder?\n› 1. Trust and continue")).toEqual({ model: null, reasoning_effort: null });
  });

  it("reads gjc's status line, keeping a model it has no id for as gjc wrote it", () => {
    expect(startScreenMetadata("gjc-transcript", GJC)).toEqual({ model: "claude-opus-5-5", reasoning_effort: "xhigh" });
    expect(startScreenMetadata("gjc-transcript", GJC.replace("opus-5.5", "kimi-k3"))).toEqual({ model: "kimi-k3", reasoning_effort: "xhigh" });
  });

  it("reads only the agents whose screen it knows", () => {
    expect(readsStartScreen("codex-transcript")).toBeTrue();
    expect(readsStartScreen("omp-transcript")).toBeTrue();
    expect(readsStartScreen("opencode-transcript")).toBeFalse();
    expect(startScreenMetadata("omo-transcript", CODEX)).toEqual({ model: null, reasoning_effort: null });
    expect(startScreenMetadata("claude-transcript", CODEX)).toEqual({ model: null, reasoning_effort: null });
  });
});

// omp 18.11.1 captured live 2026-10-19 (unicode symbols, the default compact level), with the
// provider's own names put in for the catalog's and the folder shortened
const OMP_CATALOG: OmpCatalogModel[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "gpt-6-sol", name: "GPT 6 Sol" },
  { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  { id: "gpt-oss-120b-medium", name: "GPT OSS 120B Medium" },
  { id: "gpt-image-2", name: "GPT Image 2" },
];
// a new session, before its first message: omp has written no session file
const OMP = [
  " Model scope: claude-opus-5-5, claude-sonnet-5-5, gpt-6-sol, gpt-6.1-sol (⌃P to cycle)",
  "",
  "───────────────────────────────────────────────────────────────────────────────────────────",
  " Update Available",
  " New version 18.12.2 is available. Run: omp update",
  "───────────────────────────────────────────────────────────────────────────────────────────",
  "",
  " π > ⟳ Opus 5.5 > 🗑 project > ⑂ main ▶─2%─────────────────────────────────────┃───────1M─",
  "╰─                                                          ⇧⇥ to change thinking effort",
].join("\n");
// `omp --model <provider>/gpt-6.1-sol` in a narrow pane
const OMP_NARROW = [
  " gemini-pro-agent (⌃P to cycle)",
  " π > ⟳ GPT 6.1 Sol > 🗑 …oject ▶─1%──────┃─1.1M─",
  "╰─                           ⇧⇥ to change thinking effort",
].join("\n");
// the same pane after `/switch <provider>/claude-sonnet-5-5:high`
const OMP_SWITCHED = [
  " π > ◒ Sonnet 5.5 > 🗑 …oject > ⑂ main ▶─2%─┃1M─",
  "╰─                           ⇧⇥ to change thinking effort",
].join("\n");

describe("omp's status line", () => {
  const omp = (screen: string, catalog = OMP_CATALOG) => startScreenMetadata("omp-transcript", screen, catalog);
  const unknown = { model: null, reasoning_effort: null };

  it("names the catalog id of the model the status line draws, before the session writes anything", () => {
    expect(omp(OMP)).toEqual({ model: "claude-opus-5-5", reasoning_effort: "auto" });
    expect(omp(OMP_NARROW)).toEqual({ model: "gpt-6.1-sol", reasoning_effort: "auto" });
  });

  it("follows a switch the status line draws, with the level its glyph stands for", () => {
    expect(omp(OMP_SWITCHED)).toEqual({ model: "claude-sonnet-5-5", reasoning_effort: "high" });
    expect(omp(OMP_SWITCHED.replace("◒", "⦸"))).toEqual({ model: "claude-sonnet-5-5", reasoning_effort: "off" });
    expect(omp(OMP_SWITCHED.replace("◒ Sonnet 5.5", "○ GPT 6 Sol"))).toEqual({ model: "gpt-6-sol", reasoning_effort: "minimal" });
  });

  it("reads the full segment, the other symbol presets, and a model without thinking", () => {
    expect(omp(OMP.replace("⟳ Opus 5.5", "⬢ Opus 5.5 ⚡ · ◕ xhigh"))).toEqual({ model: "claude-opus-5-5", reasoning_effort: "xhigh" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "\uec19 Opus 5.5 · \u{F0AA5} xhi"))).toEqual({ model: "claude-opus-5-5", reasoning_effort: "xhigh" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "\u{F0A9F} Opus 5.5"))).toEqual({ model: "claude-opus-5-5", reasoning_effort: "low" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "[M] Opus 5.5 - [ ] off"))).toEqual({ model: "claude-opus-5-5", reasoning_effort: "off" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "[med] Opus 5.5"))).toEqual({ model: "claude-opus-5-5", reasoning_effort: "medium" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "⬢ GPT Image 2"))).toEqual({ model: "gpt-image-2", reasoning_effort: null });
  });

  it("tells a name from a longer one it begins", () => {
    expect(omp(OMP.replace("⟳ Opus 5.5", "◑ GPT OSS 120B Medium"))).toEqual({ model: "gpt-oss-120b-medium", reasoning_effort: "medium" });
    expect(omp(OMP.replace("⟳ Opus 5.5", "◑ GPT OSS 120B"))).toEqual({ model: "gpt-oss-120b", reasoning_effort: "medium" });
  });

  it("names nothing it cannot tie to one id of the pane's catalog", () => {
    // a name cut short, or one the catalog does not list (also one that only begins with a listed name)
    expect(omp(OMP.replace("Opus 5.5", "Opus 5…"))).toEqual(unknown);
    expect(omp(OMP.replace("Opus 5.5", "Opus 6"))).toEqual(unknown);
    expect(omp(OMP.replace("Opus 5.5", "Opus 5.5 (1M)"))).toEqual(unknown);
    expect(omp(OMP.replace("Opus 5.5", "Opus 5.5 Fast"))).toEqual(unknown);
    // two providers drawing one name for different ids
    expect(omp(OMP, [...OMP_CATALOG, { id: "opus-5.5-preview", name: "Opus 5.5" }])).toEqual(unknown);
    // no catalog at all, as when it could not be listed: a global default is never shown instead
    expect(omp(OMP, [])).toEqual(unknown);
    // a name with no model icon or level glyph before it, and the selector a notice names
    expect(omp(OMP.replace("⟳ Opus 5.5", "Opus 5.5"))).toEqual(unknown);
    expect(omp(" Session-only model: provider/claude-sonnet-5-5. Use ⌥M or /model for roles.")).toEqual(unknown);
    // one line naming two models
    expect(omp(OMP_SWITCHED.replace("◒ Sonnet 5.5", "◒ Sonnet 5.5 > ⬢ Opus 5.5"))).toEqual(unknown);
  });

  it("keeps one id that two providers list under one name", () => {
    expect(omp(OMP, [...OMP_CATALOG, { id: "claude-opus-5-5", name: "Claude Opus 5.5" }])).toEqual({ model: "claude-opus-5-5", reasoning_effort: "auto" });
  });
});
