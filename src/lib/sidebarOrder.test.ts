import { afterEach, describe, expect, it } from "bun:test";

import type { PaneInfo } from "../../shared/protocol.ts";
import { activityOrder, anySeen, carrySeen, forgetSeen, isSeenDone, liveSeqs, loadSeen, markSeen, newSeqMemory, pruneSeen, saveSeen, seedSeen, shownStatus, stateSeqs } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const pane = (id: string, agent_status: string, workspace_id = `w-${id}`) => ({ pane_id: id, workspace_id, agent_status }) as PaneInfo;
const ids = (list: PaneInfo[]) => list.map((entry) => entry.pane_id);

describe("state_change_seq", () => {
  it("is read from the snapshot's agents, the only place session.snapshot carries it", () => {
    const seqs = stateSeqs({ agents: [{ pane_id: "a", state_change_seq: 7 }, { pane_id: "b" }, { pane_id: "c", state_change_seq: "9" }] } as never);
    expect([...seqs]).toEqual([["a", 7]]);
    expect(stateSeqs(null).size).toBe(0);
  });
});

describe("live counters", () => {
  const snap = (statuses: Record<string, string>, seqs: Record<string, number>) => ({
    panes: Object.entries(statuses).map(([id, status]) => pane(id, status)),
    agents: Object.entries(seqs).map(([pane_id, state_change_seq]) => ({ pane_id, state_change_seq })),
  }) as never;

  it("dates a pushed status change above every known counter until herdr's own counter comes", () => {
    const memory = newSeqMemory();
    expect([...liveSeqs(snap({ a: "idle", b: "done" }, { a: 5, b: 9 }), memory)]).toEqual([["a", 5], ["b", 9]]);
    // a is sent a message: the push changes its status, the counter is still 5
    const pushed = liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    expect(pushed.get("a")!).toBeGreaterThan(9);
    // it finishes before the roster is read again: dated later still, so it is a new change
    const finished = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    expect(finished.get("a")!).toBeGreaterThan(pushed.get("a")!);
    // herdr's counter arrives and replaces the stand-in
    expect(liveSeqs(snap({ a: "done", b: "done" }, { a: 11, b: 9 }), memory).get("a")).toBe(11);
    expect(memory.bumped.size).toBe(0);
  });

  it("keeps a look made at a stand-in counter when herdr's own counter replaces it", () => {
    // devswha's reproduction on #529: a finish watched on screen, then another pane opened before
    // the roster read brought its counter
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    const pushed = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    const seen = markSeen({}, "a", pushed.get("a")!);
    const read = liveSeqs(snap({ a: "done", b: "done" }, { a: 10, b: 9 }), memory);
    expect(memory.promoted.get("a")).toEqual({ from: pushed.get("a")!, to: 10 });
    expect(shownStatus(pane("a", "done"), read, seen)).toBe("done");
    const carried = carrySeen(seen, memory.promoted);
    expect(carried).toEqual({ a: 10 });
    expect(shownStatus(pane("a", "done"), read, carried)).toBe("idle");
    // a later change is not a look: the record stays behind it
    liveSeqs(snap({ a: "working", b: "done" }, { a: 10, b: 9 }), memory);
    const next = liveSeqs(snap({ a: "done", b: "done" }, { a: 12, b: 9 }), memory);
    expect(shownStatus(pane("a", "done"), next, carrySeen(carried, memory.promoted))).toBe("done");
    expect(carrySeen(carried, new Map())).toBe(carried);
  });

  it("does not date a pane's first sighting, or a pane with no counter", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", shell: "unknown" }, { a: 5 }), memory);
    const next = liveSeqs(snap({ a: "idle", shell: "working", c: "done" }, { a: 5, c: 7 }), memory);
    expect([...next]).toEqual([["a", 5], ["c", 7]]);
  });
});

describe("activity order", () => {
  const agents = [pane("idle", "idle"), pane("working", "working"), pane("blocked", "blocked"), pane("done-old", "done"), pane("done-new", "done"), pane("nocount", "idle")];
  const seqs = new Map([["idle", 50], ["working", 10], ["blocked", 1], ["done-old", 20], ["done-new", 30]]);
  const order = (rows: PaneInfo[], counters = seqs) => ids(activityOrder(rows, (row) => row, counters));

  it("puts blocked first, then the latest change first whatever the state", () => {
    expect(order(agents)).toEqual(["blocked", "idle", "done-new", "done-old", "working", "nocount"]);
  });

  it("keeps the agent just worked in on top while it runs and after it finishes", () => {
    // a message sent from "done-old": it starts working, so its counter is the newest
    const sent = agents.map((entry) => entry.pane_id === "done-old" ? pane("done-old", "working") : entry);
    const running = new Map([...seqs, ["done-old", 60]]);
    expect(order(sent, running).slice(0, 2)).toEqual(["blocked", "done-old"]);
    expect(order(agents, new Map([...running, ["done-old", 61]])).slice(0, 2)).toEqual(["blocked", "done-old"]);
  });

  it("puts a new agent on top, and keeps the given order between equals", () => {
    const fresh = [...agents, pane("new", "idle"), pane("tie", "idle")];
    expect(order(fresh, new Map([...seqs, ["new", 99]])).slice(0, 2)).toEqual(["blocked", "new"]);
    // without a counter, rows keep the order given, at the end
    expect(order(fresh).slice(-3)).toEqual(["nocount", "new", "tie"]);
  });
});

describe("opened finishes", () => {
  const seqs = new Map([["a", 10], ["b", 12]]);

  it("counts a DONE as looked at while its counter has not moved past the record", () => {
    expect(isSeenDone(pane("a", "done"), seqs, { a: 10 })).toBe(true);
    expect(isSeenDone(pane("a", "done"), seqs, { a: 9 })).toBe(false);
    expect(isSeenDone(pane("a", "idle"), seqs, { a: 10 })).toBe(false);
    // never recorded, or no counter (a shell): not looked at
    expect(isSeenDone(pane("b", "done"), seqs, {})).toBe(false);
    expect(isSeenDone(pane("c", "done"), seqs, { c: 3 })).toBe(false);
  });

  it("draws a looked-at DONE as ready, and every other status as it is", () => {
    expect(shownStatus(pane("a", "done"), seqs, { a: 10 })).toBe("idle");
    expect(shownStatus(pane("a", "done"), seqs, { a: 9 })).toBe("done");
    expect(shownStatus(pane("a", "blocked"), seqs, { a: 10 })).toBe("blocked");
    expect(shownStatus(pane("a", "done"), seqs, null)).toBe("done");
  });

  it("seeds a first record as all looked at, so turning the setting on starts quiet", () => {
    const seeded = seedSeen([pane("a", "done"), pane("b", "done"), pane("c", "idle")], seqs);
    expect(seeded).toEqual({ a: 10, b: 12 });
    expect(shownStatus(pane("b", "done"), seqs, seeded)).toBe("idle");
  });

  it("keeps the same record object when nothing changes, and forgets closed panes but not on an empty roster", () => {
    const record = { a: 10, gone: 3 };
    expect(markSeen(record, "a", 10)).toBe(record);
    expect(markSeen(record, "a", 11)).toEqual({ a: 11, gone: 3 });
    expect(pruneSeen(record, [pane("a", "done")])).toEqual({ a: 10 });
    expect(pruneSeen({ a: 10 }, [pane("a", "done")])).toEqual({ a: 10 });
    expect(pruneSeen(record, [])).toBe(record);
  });
});

it("defaults to herdr's order and herdr's DONE, and accepts only known values", () => {
  expect([DEFAULT_SETTINGS.agentOrder, DEFAULT_SETTINGS.quietOpenedDone]).toEqual(["workspace", false]);
  expect(sanitizeSettings({ agentOrder: "activity", quietOpenedDone: true })).toMatchObject({ agentOrder: "activity", quietOpenedDone: true });
  expect(sanitizeSettings({ agentOrder: "recent", quietOpenedDone: "yes" })).toMatchObject({ agentOrder: "workspace", quietOpenedDone: false });
});

describe("records in storage", () => {
  const original = (globalThis as { localStorage?: Storage }).localStorage;
  const fake = () => {
    const data = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      get length() { return data.size; },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
    return data;
  };
  afterEach(() => { (globalThis as { localStorage?: unknown }).localStorage = original; });

  it("knows whether the setting was on here before, and drops removed PCs", () => {
    const data = fake();
    data.set("herdr-web-ui:settings", "{}");
    expect(anySeen()).toBe(false);
    saveSeen("local", { a: 3 });
    saveSeen("box", { b: 4 });
    expect(anySeen()).toBe(true);
    expect(loadSeen("local")).toEqual({ a: 3 });
    forgetSeen(["local"]);
    expect(loadSeen("box")).toBeNull();
    expect(loadSeen("local")).toEqual({ a: 3 });
    expect(data.has("herdr-web-ui:settings")).toBe(true);
  });

  it("reads a damaged record as none, keeping only numbers", () => {
    const data = fake();
    data.set("herdr-web-ui:seen:local", "not json");
    expect(loadSeen("local")).toBeNull();
    data.set("herdr-web-ui:seen:local", JSON.stringify({ a: 3, b: "x", c: null }));
    expect(loadSeen("local")).toEqual({ a: 3 });
  });
});
