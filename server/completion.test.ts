import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("keeps what finished, and what was working, across a restart of this server", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("finished", "working", "gjc");
      expect(before.observe("finished", "idle", "gjc")).toBe("done");
      // omo mid-turn when the server stopped, and finished before it came back
      before.observe("running", "working", "pi");
      const after = new CompletionTracker(file, () => "herdr-a");
      const panes = after.present(snapshot([{ id: "finished", status: "idle" }, { id: "running", status: "idle" }])).panes;
      expect(panes.map((pane) => pane.agent_status)).toEqual(["done", "done"]);
      // seen after the restart stays seen after the next one
      expect(after.seen("finished")).toBe(true);
      const again = new CompletionTracker(file, () => "herdr-a");
      expect(again.present(snapshot([{ id: "finished", status: "idle" }, { id: "running", status: "idle" }])).panes.map((pane) => pane.agent_status)).toEqual(["idle", "done"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops what was kept for another herdr, whose pane ids name other panes, and a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working");
      before.observe("p", "idle");
      const restarted = new CompletionTracker(file, () => "herdr-b");
      expect(restarted.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      writeFileSync(file, "{not json");
      expect(new CompletionTracker(file, () => "herdr-a").present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      // without a herdr to name, nothing is written: it could not be told apart later
      const nowhere = join(dir, "none.json");
      new CompletionTracker(nowhere, () => null).observe("p", "working");
      expect(existsSync(nowhere)).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ herdr: "herdr-a" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
