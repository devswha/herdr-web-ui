import { afterEach, expect, it, mock } from "bun:test";
import { ReplayBuffer } from "../output-window.ts";
import { connectionData, type Client } from "./connections.ts";
import type { PaneAttachment } from "./terminal-process.ts";
import type { ServerMessage } from "../../shared/protocol.ts";

let attachment: PaneAttachment;
mock.module("./terminal-process.ts", () => ({
  ATTACH_HELD_MESSAGE: "Held",
  createSpawnAttachment: ({ attachments }: { attachments: Map<string, PaneAttachment> }) => ({
    spawnAttachment: async (pane: string) => { attachments.set(pane, attachment); return attachment; },
  }),
}));
const { createTerminalRegistry } = await import("./terminals.ts");

afterEach(() => mock.restore());

for (const readOnly of [false, true]) for (const ready of [false, true]) {
  it(`sends readiness ${ready} before replay to a ${readOnly ? "observer" : "owner"} joining a shared attach`, async () => {
    const frames: ServerMessage[] = [];
    const client = {
      data: connectionData({ deviceId: undefined, readOnly }), readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0, send: (text: string) => { frames.push(JSON.parse(text)); return text.length; },
      close() {},
    } as unknown as Client;
    const replay = new ReplayBuffer(1024);
    replay.append("retained screen");
    attachment = {
      kind: "pty", ready, cols: 80, rows: 24, clients: new Set(), grids: new Map(), stalled: new Map(), replay,
      process: { exited: Promise.resolve(), pause() {}, resume() {}, resize() {}, winch() {}, kill() {}, write() {} } as unknown as Extract<PaneAttachment, { kind: "pty" }>["process"],
    };
    const registry = createTerminalRegistry({
      options: {}, clients: new Set([client]), stopped: () => false, terminalAttach: async () => true,
      holdFor: 0, heldRetry: 0, retryFor: 0, relookupFor: 0,
      holdPending() {}, holdPendingPane() {}, end() {},
    });
    await registry.terminalFrames.attach(client, { type: "attach", pane_id: "p", cols: 80, rows: 24, keep_size: true });
    expect(frames.slice(0, 2)).toEqual([
      { type: "input-ready", pane_id: "p", ...(ready ? {} : { ready: false }) },
      { type: "pty-data", pane_id: "p", data: "retained screen" },
    ]);
    registry.closeAttachment("p");
    registry.conversations.stop();
  });
}
