import { describe, expect, it } from "bun:test";
import type { Machine, MachineState } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import fixture from "../../site/demo/fixtures/machines.json";
import { agentRoster } from "./agentRoster.ts";
import { attentionCandidates, nextAttentionTarget, type AttentionStatus } from "./attentionJump.ts";
import { shownStatus, type SeenRecord } from "./sidebarOrder.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

const template = fixture.machines[0]!.snapshot as SessionSnapshot;
const templatePane = template.panes.find((pane) => pane.agent) ?? template.panes[0]!;
const workspace = template.workspaces[0]!;

/** a PC whose agents are the named panes, in that order, each with its own status and finish id */
function machine(id: string, state: MachineState, panes: [id: string, status: AgentStatus, finish?: number][]): Machine {
  const snapshot: SessionSnapshot = {
    ...template,
    finish_epoch: `epoch-${id}`,
    panes: panes.map(([pane_id, agent_status, finish_id]): HerdrPane => ({ ...templatePane, pane_id, agent_status, finish_id, workspace_id: workspace.workspace_id, agent: "claude", background_wait: undefined })),
    agents: panes.map(([pane_id, agent_status], index) => ({ ...template.agents[0]!, pane_id, agent_status, agent: "claude", state_change_seq: index + 1 })),
  };
  return { id, name: id, kind: id === "local" ? "local" : "ssh", enabled: true, state, error: null, snapshot };
}

/** the badge's status: a finish counts as looked at where `seen` says so, per PC */
const statusWith = (seen: Record<string, SeenRecord>): AttentionStatus => (machineId, pane) => shownStatus(pane, seen[machineId] ?? null);
const noneSeen = statusWith({});
const roster = (machines: Machine[], pinned: string[] = []) => {
  const split = agentRoster(machines, { byActivity: false, seqs: () => new Map(), pinned });
  return [...split.pinned, ...split.rest];
};
const ids = (targets: readonly { machineId: string; paneId: string }[]) => targets.map((target) => `${target.machineId}/${target.paneId}`);

describe("attention candidates", () => {
  it("blocked then unseen preserves display order", () => {
    const machines = [
      machine("local", "connected", [["a", "done", 1], ["b", "blocked"], ["c", "working"], ["d", "done", 1], ["e", "idle"], ["f", "blocked"]]),
      machine("remote", "connected", [["g", "done", 2], ["h", "blocked"]]),
    ];
    expect(ids(attentionCandidates(roster(machines), noneSeen))).toEqual(["local/b", "local/f", "remote/h", "local/a", "local/d", "remote/g"]);
    // a pinned row leads the list, so it leads its class too; the rest keep the roster's order
    const pinned = [sidebarPinKey("remote", "g"), sidebarPinKey("local", "f")];
    expect(ids(attentionCandidates(roster(machines, pinned), noneSeen))).toEqual(["local/f", "local/b", "remote/h", "remote/g", "local/a", "local/d"]);
  });

  it("duplicate pane ids stay machine scoped", () => {
    const machines = [machine("local", "connected", [["p1", "blocked"], ["p2", "done", 1]]), machine("remote", "connected", [["p1", "blocked"], ["p2", "done", 1]])];
    const candidates = attentionCandidates(roster(machines), noneSeen);
    expect(ids(candidates)).toEqual(["local/p1", "remote/p1", "local/p2", "remote/p2"]);
    expect(nextAttentionTarget(candidates, { machineId: "local", paneId: "p1" })).toEqual({ machineId: "remote", paneId: "p1" });
    expect(nextAttentionTarget(candidates, { machineId: "remote", paneId: "p1" })).toEqual({ machineId: "local", paneId: "p2" });
    expect(nextAttentionTarget(candidates, { machineId: "remote", paneId: "p2" })).toEqual({ machineId: "local", paneId: "p1" });
    // the same finish read on one PC leaves the other PC's own pane wanted
    const seenOnLocal = attentionCandidates(roster(machines), statusWith({ local: { p2: 1 } }));
    expect(ids(seenOnLocal)).toEqual(["local/p1", "remote/p1", "remote/p2"]);
  });

  it("sole current candidate wraps to itself", () => {
    const candidates = attentionCandidates(roster([machine("local", "connected", [["a", "idle"], ["b", "blocked"]])]), noneSeen);
    expect(ids(candidates)).toEqual(["local/b"]);
    expect(nextAttentionTarget(candidates, { machineId: "local", paneId: "b" })).toEqual({ machineId: "local", paneId: "b" });
    // from anywhere else, or from no pane, the one candidate is the target
    expect(nextAttentionTarget(candidates, { machineId: "local", paneId: "a" })).toEqual({ machineId: "local", paneId: "b" });
    expect(nextAttentionTarget(candidates, { machineId: "local", paneId: null })).toEqual({ machineId: "local", paneId: "b" });
    // the last candidate wraps to the first
    const two = attentionCandidates(roster([machine("local", "connected", [["a", "blocked"], ["b", "blocked"]])]), noneSeen);
    expect(nextAttentionTarget(two, { machineId: "local", paneId: "b" })).toEqual({ machineId: "local", paneId: "a" });
  });

  it("offline PCs and seen finishes are skipped", () => {
    const states: MachineState[] = ["connecting", "reconnecting", "disconnected", "error"];
    const machines = [
      machine("local", "connected", [["seen", "done", 3], ["unseen", "done", 4], ["stale", "done", 5], ["bg", "done", 6], ["blocked", "blocked"]]),
      ...states.map((state) => machine(state, state, [["x", "blocked"], ["y", "done", 1]])),
    ];
    machines[0]!.snapshot!.panes[3]!.background_wait = true;
    const candidates = attentionCandidates(roster(machines), statusWith({ local: { seen: 3, stale: 4 } }));
    expect(ids(candidates)).toEqual(["local/blocked", "local/unseen", "local/stale"]);
    // a loading PC (connected, no roster yet) has no rows either
    const loading: Machine = { ...machine("loading", "connected", []), snapshot: null };
    expect(roster([loading])).toEqual([]);
  });

  it("empty roster is a no-op", () => {
    expect(nextAttentionTarget([], { machineId: "local", paneId: "a" })).toBeNull();
    expect(nextAttentionTarget([], { machineId: "local", paneId: null })).toBeNull();
    expect(attentionCandidates(roster([machine("local", "connected", [["a", "working"], ["b", "idle"]])]), noneSeen)).toEqual([]);
    expect(attentionCandidates(roster([]), noneSeen)).toEqual([]);
  });
});

describe("agent roster", () => {
  it("keeps the pinned card first in pin order and each PC's rows in its own Activity order", () => {
    const machines = [machine("local", "connected", [["a", "done", 1], ["b", "blocked"], ["c", "working"]]), machine("remote", "connected", [["d", "idle"], ["e", "blocked"]])];
    const seqs = new Map<string, ReadonlyMap<string, number>>([["local", new Map([["a", 1], ["b", 2], ["c", 3]])], ["remote", new Map([["d", 9], ["e", 1]])]]);
    const split = agentRoster(machines, { byActivity: true, seqs: (id) => seqs.get(id) ?? new Map(), pinned: [sidebarPinKey("remote", "d"), sidebarPinKey("local", "c")] });
    const key = ({ machine, entry }: { machine: Machine; entry: { pane: HerdrPane } }) => `${machine.id}/${entry.pane.pane_id}`;
    expect(split.pinned.map(key)).toEqual(["remote/d", "local/c"]);
    // blocked first, then the latest change, within each PC; the PCs keep their order
    expect(split.rest.map(key)).toEqual(["local/b", "local/a", "remote/e"]);
  });
});
