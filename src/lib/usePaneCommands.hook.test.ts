import { afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SlashCommand } from "../../shared/protocol.ts";
import { invalidatePaneCommands } from "./paneCommandCache.ts";
import { usePaneCommands } from "./usePaneCommands.ts";

const config: SlashCommand = { name: "config", description: "Open config", source: "builtin", visibility: "terminal" };

// Keep React, the hook, its cache and the API function real; only the network is a stand-in.
describe("usePaneCommands after a failed read", () => {
  let renderer: ReactTestRenderer | null = null;
  let down = false;
  let seen: readonly SlashCommand[] = [];
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  function Probe({ pane }: { pane: string }) { seen = usePaneCommands(pane, "claude"); return null; }
  /** Lets the read's promise chain finish: a bounded number of turns, each inside act. */
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };

  beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  beforeEach(() => {
    jest.useFakeTimers();
    down = false; seen = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (down) throw new TypeError("network down");
      return Response.json({ commands: [config] });
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  it("asks again instead of keeping an empty list for good", async () => {
    down = true;
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p1" })); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    expect(seen).toEqual([]);
    down = false;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
  });

  it("keeps the list it had while a fresh read fails", async () => {
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p2" })); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    down = true;
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { invalidatePaneCommands("w-retry:p2", "local"); });
    await settle(() => fetchSpy.mock.calls.length > calls);
    await settle(() => false);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    // and still asks again once the failed read's wait is over
    const failed = fetchSpy.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => fetchSpy.mock.calls.length > failed);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(failed);
  });
});
