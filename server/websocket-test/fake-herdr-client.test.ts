import { describe, expect, test } from "bun:test";
import {
  FakeBoundaryError,
  getFakeHerdrCounters,
  resetFakeHerdrCounters,
  sessionSnapshot,
  subscribeEvents,
  workspaceCreate,
  unexpectedRpc,
} from "./fake-herdr-client.ts";

describe("fake Herdr boundary", () => {
  test("returns deterministic pane and layout snapshot", async () => {
    const snapshot = await sessionSnapshot();
    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.panes[0]).toMatchObject({
      pane_id: "fake-pane",
      terminal_id: "terminal-1",
      workspace_id: "workspace-1",
      tab_id: "tab-1",
      agent_status: "idle",
    });
    expect(snapshot.layouts[0]?.panes[0]?.rect).toEqual({ x: 0, y: 0, width: 120, height: 40 });
  });

  test("closes subscriptions once and counts closure", () => {
    resetFakeHerdrCounters();
    const subscription = subscribeEvents([], { onEvent: () => undefined });
    subscription.close();
    subscription.close();
    expect(getFakeHerdrCounters()).toEqual({ subscriptionCloseCount: 1 });
  });

  test("rejects workspace creation and unexpected RPC at the fake boundary", async () => {
    resetFakeHerdrCounters();
    await expect(workspaceCreate({ label: "must not create" })).rejects.toBeInstanceOf(FakeBoundaryError);
    await expect(unexpectedRpc("unrecognized.call")).rejects.toMatchObject({ method: "unrecognized.call" });
    expect(getFakeHerdrCounters()).toEqual({ subscriptionCloseCount: 0 });
  });
});
