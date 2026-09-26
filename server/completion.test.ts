import { describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";

const snapshot = (panes: { id: string; status: string; focused?: boolean }[]): SessionSnapshot => ({
  panes: panes.map((pane) => ({ pane_id: pane.id, agent: "claude", agent_status: pane.status, focused: pane.focused ?? false })),
  agents: panes.map((pane) => ({ pane_id: pane.id, agent_status: pane.status, focused: pane.focused ?? false })),
} as unknown as SessionSnapshot);

describe("CompletionTracker", () => {
  it("reports an idle after work as done until focus moves onto the pane, as herdr does for agents it does not lose", () => {
    const tracker = new CompletionTracker();
    // omo, live-traced: pi/working, then claude/unknown, then claude/idle
    expect(tracker.observe("p", "working", "pi")).toBe("working");
    // the turn goes on under omo's claude child: still working, not unknown
    expect(tracker.observe("p", "unknown", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    // snapshots keep saying done until the pane is seen
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.seen("p")).toBe(false);
  });

  it("finishes the pane herdr has focused as done: nobody moved focus there to see it", () => {
    // live: the browser sent work to herdr's focused pane, which went working -> idle
    const tracker = new CompletionTracker();
    expect(tracker.observe("p", "working", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    // a snapshot with the focus it had all along does not count as seeing it
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
  });

  it("leaves idle alone when the pane never worked, herdr said done itself, or it works again", () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("q", "working");
    expect(tracker.observe("q", "done")).toBe("done");
    // herdr's own done turns idle when its terminal brings the pane to the front
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("r", "working");
    expect(tracker.observe("r", "idle")).toBe("done");
    expect(tracker.observe("r", "working")).toBe("working");
    expect(tracker.seen("r")).toBe(false);
  });

  it("lets an unknown with no agent left be unknown: the agent quit", () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "gjc");
    expect(tracker.observe("p", "unknown", null)).toBe("unknown");
    expect(tracker.observe("p", "idle", null)).toBe("idle");
  });

  it("forgets panes that left the snapshot", () => {
    const tracker = new CompletionTracker();
    tracker.observe("gone", "working");
    tracker.observe("gone", "idle");
    tracker.present(snapshot([]));
    expect(tracker.present(snapshot([{ id: "gone", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
  });
});
