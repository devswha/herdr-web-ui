import { describe, expect, it } from "bun:test";
import type { AgentKind } from "../../shared/protocol.ts";
import { favoritesFirst, toggleFavorite } from "./agentFavorites.ts";

const agents: AgentKind[] = [
  { kind: "claude", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "gemini", label: "Gemini" },
  { kind: "omo", label: "OmO" },
  { kind: "pi", label: "pi" },
];
const kinds = (list: AgentKind[]) => list.map((agent) => agent.kind);

describe("favorite agent order", () => {
  it("lists the server's order untouched while nothing is a favorite", () => {
    expect(kinds(favoritesFirst(agents, []))).toEqual(["claude", "codex", "gemini", "omo", "pi"]);
  });

  it("puts favorites first in the server's order, not the order they were starred in, and keeps the rest's order", () => {
    expect(kinds(favoritesFirst(agents, ["pi", "codex"]))).toEqual(["codex", "pi", "claude", "gemini", "omo"]);
  });

  it("ignores a favorite this PC does not offer, and never adds or drops an agent", () => {
    const ordered = favoritesFirst(agents, ["remote-only", "omo", ""]);
    expect(kinds(ordered)).toEqual(["omo", "claude", "codex", "gemini", "pi"]);
    expect([...ordered].sort((left, right) => left.kind.localeCompare(right.kind))).toEqual(agents);
  });

  it("leaves the server's list as it was", () => {
    const before = kinds(agents);
    favoritesFirst(agents, ["pi"]);
    expect(kinds(agents)).toEqual(before);
  });
});

describe("toggling a favorite", () => {
  it("adds a kind at the end and takes it out again", () => {
    const starred = toggleFavorite(["codex"], "pi");
    expect(starred).toEqual(["codex", "pi"]);
    expect(toggleFavorite(starred, "codex")).toEqual(["pi"]);
  });

  it("keeps a favorite of another PC while this one toggles its own", () => {
    expect(toggleFavorite(["remote-only"], "codex")).toEqual(["remote-only", "codex"]);
    expect(toggleFavorite(["remote-only", "codex"], "codex")).toEqual(["remote-only"]);
  });

  it("never makes Shell a favorite", () => {
    expect(toggleFavorite([], "")).toEqual([]);
    expect(toggleFavorite(["codex"], "")).toEqual(["codex"]);
  });

  it("returns a new list and leaves the one it was given alone", () => {
    const favorites = ["codex"];
    expect(toggleFavorite(favorites, "pi")).not.toBe(favorites);
    expect(favorites).toEqual(["codex"]);
  });
});
