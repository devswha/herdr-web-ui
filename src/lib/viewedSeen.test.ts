import { describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { seenStep } from "./viewedSeen.ts";

/** Each view in turn, from nothing told: the views that tell herdr. */
function tells(views: { key: string | null; status: AgentStatus | undefined; inView: boolean }[]): number[] {
  let told: string | null = null;
  const toldAt: number[] = [];
  views.forEach((view, index) => {
    const step = seenStep(told, view.key, view.status, view.inView);
    told = step.told;
    if (step.tell) toldAt.push(index);
  });
  return toldAt;
}

describe("telling herdr a finish open here was seen", () => {
  it("tells once per finish of the opened pane in view, and again for its next finish", () => {
    expect(tells([
      { key: "local:p1", status: "working", inView: true },
      { key: "local:p1", status: "done", inView: true },
      // a poll, a reconnect: the same finish
      { key: "local:p1", status: "done", inView: true },
      { key: "local:p1", status: "idle", inView: true },
      { key: "local:p1", status: "working", inView: true },
      { key: "local:p1", status: "done", inView: true },
    ])).toEqual([1, 5]);
  });

  it("never tells for a pane the app picked itself, a pane not done, or a page out of view", () => {
    expect(tells([
      { key: null, status: "done", inView: true },
      { key: "local:p1", status: "idle", inView: true },
      { key: "local:p1", status: "blocked", inView: true },
      { key: "local:p1", status: undefined, inView: true },
      { key: "local:p1", status: "done", inView: false },
    ])).toEqual([]);
  });

  it("tells when a finish already open comes into view, once", () => {
    expect(tells([
      { key: "local:p1", status: "done", inView: false },
      { key: "local:p1", status: "done", inView: true },
      { key: "local:p1", status: "done", inView: false },
      { key: "local:p1", status: "done", inView: true },
    ])).toEqual([1]);
  });

  it("tells for each finished pane opened in turn, the same pane id on another PC included", () => {
    expect(tells([
      { key: "local:p1", status: "done", inView: true },
      { key: "local:p2", status: "done", inView: true },
      { key: "office:p2", status: "done", inView: true },
    ])).toEqual([0, 1, 2]);
  });
});
