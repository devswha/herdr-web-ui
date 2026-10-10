import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { createServerHarness, evidenceDirectory } from "./create-server-harness.ts";
import { onPtyEvent } from "./fake-pty-session.ts";
import { getFakeHerdrCounters } from "./fake-herdr-client.ts";

const evidencePath = resolve(evidenceDirectory(), "protocol-guards.jsonl");
const cleanupPath = resolve(evidenceDirectory(), "protocol-guards-cleanup.json");
const timeoutMs = 5000;

interface WsFrame { readonly type: string; readonly [key: string]: unknown }

function messageWait(socket: WebSocket, diagnostic: string): Promise<WsFrame> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try {
        const frame: unknown = JSON.parse(String(event.data));
        if (typeof frame !== "object" || frame === null || !("type" in frame) || typeof frame.type !== "string") throw new Error("frame has no type");
        resolvePromise(frame as WsFrame);
      } catch (error) { rejectPromise(error); }
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

test("real server rejects malformed protocol and observer mutations", async () => {
  await mkdir(evidenceDirectory(), { recursive: true });
  const harness = await createServerHarness();
  const socket = harness.openSocket();
  const openWait = harness.prearmSocketEvent("open");
  const snapshotWait = messageWait(socket, "timed out waiting for initial snapshot");
  const waits: Promise<unknown>[] = [openWait, snapshotWait];
  let exitEvent: Promise<void> | undefined;
  let unsubscribeExit: (() => void) | undefined;
  let fakeExited: Promise<void> | undefined;
  let cleanupReceipt: Record<string, unknown> | undefined;
  try {
    const [opened, snapshot] = await Promise.all([openWait, snapshotWait]);
    expect(opened.socket).toBe(socket);
    expect(snapshot.type).toBe("snapshot");

    const observedFrames: WsFrame[] = [];
    const protocolOrder: string[] = [];
    const expectedMessages: Record<string, string> = {
      invalid_json: "message must be JSON",
      invalid_flow_control: "flow_control must be ack",
      invalid_geometry: "cols and rows must be integers in 1..1000",
      read_only: "this connection is in observe mode",
    };
    const sendAndExpect = async (raw: string, code: string): Promise<WsFrame> => {
      const responseWait = messageWait(socket, `timed out waiting for ${code}`);
      waits.push(responseWait);
      socket.send(raw);
      const frame = await responseWait;
      expect(frame).toEqual({ type: "error", code, message: expectedMessages[code] });
      observedFrames.push(frame);
      protocolOrder.push(code);
      return frame;
    };

    await sendAndExpect("{", "invalid_json");
    await sendAndExpect(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 120, rows: 40, flow_control: "bogus" }), "invalid_flow_control");
    await sendAndExpect(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 0, rows: 40 }), "invalid_geometry");

    const roleWait = messageWait(socket, "timed out waiting for observe role acknowledgement");
    waits.push(roleWait);
    socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    const roleAck = await roleWait;
    expect(roleAck).toEqual({ type: "role-ack", mode: "observe" });
    protocolOrder.push("role-ack");

    const attachWait = messageWait(socket, "timed out waiting for valid observer attach");
    waits.push(attachWait);
    socket.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 120, rows: 40, flow_control: "ack" }));
    const attached = await attachWait;
    expect(["pane-geometry", "pty-data"]).toContain(attached.type);
    if (attached.type === "pty-data") {
      const geometryWait = messageWait(socket, "timed out waiting for observer geometry");
      waits.push(geometryWait);
      const geometry = await geometryWait;
      expect(geometry.type).toBe("pane-geometry");
    }

    const inputErrorWait = messageWait(socket, "timed out waiting for read_only input error");
    waits.push(inputErrorWait);
    socket.send(JSON.stringify({ type: "input", pane_id: harness.paneId, text: "must-not-write" }));
    const inputError = await inputErrorWait;
    expect(inputError).toEqual({ type: "error", code: "read_only", message: expectedMessages["read_only"] });
    observedFrames.push(inputError);
    protocolOrder.push("read_only");

    const inputErrorIndex = observedFrames.length - 1;
    await sendAndExpect(JSON.stringify({ type: "resize", pane_id: harness.paneId, cols: 120, rows: 40 }), "read_only");
    expect(observedFrames.map((frame) => frame.code)).toEqual(["invalid_json", "invalid_flow_control", "invalid_geometry", "read_only", "read_only"]);
    expect(inputErrorIndex).toBe(3);
    expect(protocolOrder).toEqual(["invalid_json", "invalid_flow_control", "invalid_geometry", "role-ack", "read_only", "read_only"]);
    const fake = harness.instances.at(-1);
    expect(fake).toBeDefined();
    expect(fake?.writes).toEqual([]);
    expect(fake?.resizes).toEqual([]);
    const subscriptionCountBeforeCleanup = getFakeHerdrCounters().subscriptionCloseCount;
    exitEvent = new Promise<void>((resolvePromise) => {
      const unsubscribe = onPtyEvent((event) => {
        if (event.type !== "exit") return;
        unsubscribe();
        resolvePromise();
      });
      unsubscribeExit = unsubscribe;
    });
    fakeExited = fake?.exited;
    await writeFile(evidencePath, `${JSON.stringify({ scenario: "S10", snapshot, actions: ["raw {", "attach flow_control bogus", "attach cols 0", "role observe", "attach valid ACK flow", "observer input must-not-write", "observer resize 120x40"], frames: observedFrames, protocolOrder, roleAck, counters: { writes: fake?.writes.length ?? 0, resizes: fake?.resizes.length ?? 0, subscriptionCloseCountBeforeCleanup: subscriptionCountBeforeCleanup } })}\n`, "utf8");
  } finally {
    const stateDir = harness.stateDir;
    const sessionExit = fakeExited ?? harness.instances.at(-1)?.exited;
    const cleanup = await harness.cleanup();
    await Promise.allSettled(waits);
    let fakeExitedResolved = false;
    if (sessionExit) { await sessionExit; fakeExitedResolved = true; }
    if (exitEvent) await exitEvent;
    unsubscribeExit?.();
    const stateDirAbsent = await access(stateDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const stoppedPortHandshakeFailed = await new Promise<boolean>((resolvePromise, rejectPromise) => {
      const stopped = new WebSocket(new URL("/ws", harness.baseUrl));
      let timer: ReturnType<typeof setTimeout>;
      const settle = (failed: boolean) => {
        clearTimeout(timer);
        stopped.removeEventListener("error", onError);
        stopped.removeEventListener("open", onOpen);
        if (failed) resolvePromise(true);
        else { stopped.close(); resolvePromise(false); }
      };
      const onError = () => settle(true);
      const onOpen = () => settle(false);
      timer = setTimeout(() => { stopped.close(); rejectPromise(new Error("stopped-port handshake did not settle")); }, 1000);
      stopped.addEventListener("error", onError);
      stopped.addEventListener("open", onOpen);
    });
    cleanupReceipt = {
      scenario: "S10",
      socketsClosed: socket.readyState === WebSocket.CLOSED,
      fakeExitedResolved,
      subscriptionCloseDelta: cleanup.subscriptionCloseDelta,
      stateDirAbsent,
      stoppedPortHandshakeFailed,
    };
    await writeFile(cleanupPath, `${JSON.stringify({ cases: [cleanupReceipt] }, null, 2)}\n`, "utf8");
    unsubscribeExit?.();
  }
  expect(cleanupReceipt).toMatchObject({ socketsClosed: true, fakeExitedResolved: true, stateDirAbsent: true, stoppedPortHandshakeFailed: true });
  expect(Number(cleanupReceipt?.subscriptionCloseDelta)).toBeGreaterThan(0);
}, 15000);
