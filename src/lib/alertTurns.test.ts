import { describe, expect, it, jest } from "bun:test";
import { AlertTurns, createAlertTurnPlayer, type AlertTurnMessage } from "./alertTurns.ts";

const key = JSON.stringify(["local", "pane-1", "blocked"]);
const claim: AlertTurnMessage = { type: "claim", tab: "a", key, kind: "blocked" };
const chimed: AlertTurnMessage = { ...claim, type: "chimed" };
const play = { type: "play", key, kind: "blocked" } as const;

describe("alert turns with a local clock", () => {
  it("lets a lone tab chime after its claim window", () => {
    const tab = new AlertTurns("b");
    expect(tab.start(key, "blocked", 0)).toEqual([{ ...claim, tab: "b" }]);
    expect(tab.tick(149)).toEqual([]);
    expect(tab.tick(150)).toEqual([play]);
  });

  it("lets the lower of two claimants chime and the other defer", () => {
    const a = new AlertTurns("a");
    const b = new AlertTurns("b");
    a.start(key, "blocked", 0);
    b.start(key, "blocked", 0);
    a.receive({ ...claim, tab: "b" }, 1);
    b.receive(claim, 1);
    expect(a.tick(150)).toEqual([play]);
    expect(b.tick(150)).toEqual([]);
    b.receive(a.finish(key, true, 150)[0]!, 151);
    expect(b.tick(750)).toEqual([]);
  });

  it("drops an alert already chimed within the local lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 100);
    expect(tab.start(key, "blocked", 200)).toEqual([]);
    expect(tab.tick(350)).toEqual([]);
  });

  it("rescues a question when the winning tab never chimes", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    expect(tab.tick(150)).toEqual([]);
    expect(tab.tick(749)).toEqual([]);
    expect(tab.tick(750)).toEqual([play]);
  });

  it("redecides a pending question immediately when its winner withdraws", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    tab.tick(150);
    expect(tab.receive({ ...claim, type: "withdraw" }, 200)).toEqual([play]);
  });

  it("does not give a finish a question safety net", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "done", 0);
    tab.receive({ ...claim, kind: "done" }, 1);
    expect(tab.tick(150)).toEqual([]);
    expect(tab.tick(750)).toEqual([]);
    expect(tab.receive({ ...claim, type: "withdraw", kind: "done" }, 800)).toEqual([]);
  });

  it("ignores claims older than the lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(claim, 0);
    tab.start(key, "blocked", 1501);
    expect(tab.tick(1651)).toEqual([play]);
  });

  it("allows the same pane to alert again after the lookback", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 0);
    tab.start(key, "blocked", 1501);
    expect(tab.tick(1651)).toEqual([play]);
  });

  it("honours a received chime even when its own timer runs very late", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(chimed, 100);
    expect(tab.tick(10_000)).toEqual([]);
  });

  it("cancels the safety net when a chime arrives", () => {
    const tab = new AlertTurns("b");
    tab.start(key, "blocked", 0);
    tab.receive(claim, 1);
    tab.tick(150);
    tab.receive(chimed, 749);
    expect(tab.tick(10_000)).toEqual([]);
  });

  it("tells a second question on the same pane that comes after the first one's chime", () => {
    const tab = new AlertTurns("b");
    tab.receive(claim, 1);
    tab.receive(chimed, 151);
    // the tab that chimed the first question no longer takes part (its pane is in front now)
    expect(tab.start(key, "blocked", 800)).toEqual([{ ...claim, tab: "b" }]);
    expect(tab.tick(950)).toEqual([play]);
  });

  it("is not silenced by a late duplicate of the chime it played itself", () => {
    const a = new AlertTurns("a");
    a.start(key, "blocked", 0);
    expect(a.tick(150)).toEqual([play]);
    a.finish(key, true, 150);
    // tab b heard the first question late and chimed it again
    a.receive({ ...chimed, tab: "b" }, 1_100);
    // the pane asks again; b now has it in front, so a is the only tab to tell it
    expect(a.start(key, "blocked", 1_480)).toEqual([claim]);
    expect(a.tick(1_630)).toEqual([play]);
  });

  it("lets a third tab wait for the second one's rescue instead of chiming with it", () => {
    const c = new AlertTurns("c");
    c.start(key, "blocked", 0);
    c.receive(claim, 1);
    c.receive({ ...claim, tab: "b" }, 1);
    expect(c.tick(150)).toEqual([]);
    expect(c.tick(750)).toEqual([]);
    c.receive({ ...chimed, tab: "b" }, 760);
    expect(c.tick(10_000)).toEqual([]);
  });

  it("still rescues a question when every lower tab is gone", () => {
    const c = new AlertTurns("c");
    c.start(key, "blocked", 0);
    c.receive(claim, 1);
    c.receive({ ...claim, tab: "b" }, 1);
    c.tick(150);
    expect(c.tick(1_349)).toEqual([]);
    expect(c.tick(1_350)).toEqual([play]);
  });

  it("keeps other machines and panes independent", () => {
    const tab = new AlertTurns("b");
    tab.receive(chimed, 0);
    tab.start("another-machine-pane", "blocked", 1);
    expect(tab.tick(151)).toEqual([{ ...play, key: "another-machine-pane" }]);
  });

  it("withdraws rather than claiming success when audio becomes unavailable", () => {
    const tab = new AlertTurns("a");
    tab.start(key, "blocked", 0);
    tab.tick(150);
    expect(tab.finish(key, false, 150)).toEqual([{ ...claim, type: "withdraw" }]);
  });

  it("withdraws and forgets live work when the page leaves", () => {
    const tab = new AlertTurns("a");
    tab.start(key, "blocked", 0);
    expect(tab.clear()).toEqual([{ ...claim, type: "withdraw" }]);
    expect(tab.tick(10_000)).toEqual([]);
    expect(tab.start(key, "blocked", 10_001)).toEqual([claim]);
  });

  it("chimes immediately when BroadcastChannel is unavailable", () => {
    const heard: string[] = [];
    const player = createAlertTurnPlayer({ channel: null, play: (kind) => { heard.push(kind); return true; } });
    player.chime(key, "blocked");
    expect(heard).toEqual(["blocked"]);
    player.dispose();
  });
  it("still tells the pane's next question after a peer's chime came while its own was queued", async () => {
    jest.useFakeTimers();
    const channel = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, postMessage() {}, close() {} };
    const heard: string[] = [];
    let release: (played: boolean) => void = () => {};
    const results: (boolean | Promise<boolean>)[] = [true, new Promise<boolean>((resolve) => { release = resolve; }), true];
    const player = createAlertTurnPlayer({
      channel: channel as unknown as BroadcastChannel,
      play: (kind) => { heard.push(kind); return results.shift() ?? true; },
    });
    try {
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      // the pane asks again; this chime waits behind another sound of the tab
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      expect(heard).toEqual(["blocked", "blocked"]);
      // another tab's chime of the first question arrives meanwhile
      channel.onmessage?.({ data: { ...chimed, tab: "b" } } as MessageEvent<unknown>);
      release(true);
      await Promise.resolve();
      jest.advanceTimersByTime(2_000);
      player.chime(key, "blocked");
      jest.advanceTimersByTime(150);
      expect(heard).toEqual(["blocked", "blocked", "blocked"]);
    } finally {
      player.dispose();
      jest.useRealTimers();
    }
  });
});
