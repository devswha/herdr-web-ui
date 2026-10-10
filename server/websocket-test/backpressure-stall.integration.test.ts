import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "../output-window.ts";
import { createServerHarness, evidenceDirectory } from "./create-server-harness.ts";

const records: Record<string, unknown>[] = [];
const receipts: Record<string, unknown>[] = [];
const closeCodeStalled = 4008;
const timeoutMs = OUTPUT_STALL_MS + 10000;
type Frame = Record<string, unknown>;

function waitMessage(socket: WebSocket, predicate: (frame: Frame) => boolean, diagnostic: string, timeout = 10000): Promise<Frame> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("message", onMessage); socket.removeEventListener("close", onClose); socket.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("websocket frame must be an object");
        const frame = parsed as Frame;
        if (!predicate(frame)) return;
        cleanup();
        resolvePromise(frame);
      } catch (error) { cleanup(); rejectPromise(error); }
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, timeout);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function waitClose(socket: WebSocket, timeout = timeoutMs): Promise<CloseEvent> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onClose = (event: CloseEvent) => { clearTimeout(timer); socket.removeEventListener("close", onClose); resolvePromise(event); };
    const timer = setTimeout(() => { socket.removeEventListener("close", onClose); rejectPromise(new Error("timed out waiting for close")); }, timeout);
    socket.addEventListener("close", onClose, { once: true });
  });
}

function waitOpen(harness: Awaited<ReturnType<typeof createServerHarness>>, socket: WebSocket): Promise<void> {
  const opened = harness.prearmSocketEvent("open");
  const snapshot = waitMessage(socket, (frame) => frame["type"] === "snapshot", "snapshot missing");
  return Promise.all([opened, snapshot]).then(([event, frame]) => {
    expect(event.socket).toBe(socket);
    expect(frame["type"]).toBe("snapshot");
  });
}

async function finish(
  name: string,
  harness: Awaited<ReturnType<typeof createServerHarness>>,
  sockets: WebSocket[],
  pending: Promise<unknown>[],
  ptyExit?: Promise<void>,
): Promise<void> {
  const stateDir = harness.stateDir;
  const instances = [...harness.instances];
  const closes = sockets.map((socket) => new Promise<void>((resolvePromise) => {
    if (socket.readyState === WebSocket.CLOSED) { resolvePromise(); return; }
    socket.addEventListener("close", () => resolvePromise(), { once: true });
    socket.close();
  }));
  const cleanup = await harness.cleanup();
  const outcomes = await Promise.allSettled(pending);
  await Promise.all(closes);
  await Promise.all(instances.map((instance) => instance.exited));
  if (ptyExit) await ptyExit;
  const stateDirAbsent = await access(stateDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const stoppedPortHandshakeFailed = await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`${harness.baseUrl}/ws`);
    let timer: ReturnType<typeof setTimeout>;
    const settle = (failed: boolean) => {
      clearTimeout(timer);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("open", onOpen);
      if (!failed) socket.close();
      resolvePromise(failed);
    };
    const onError = () => settle(true);
    const onOpen = () => settle(false);
    timer = setTimeout(() => { socket.close(); rejectPromise(new Error("stopped-port handshake did not settle")); }, timeoutMs);
    socket.addEventListener("error", onError);
    socket.addEventListener("open", onOpen);
  });
  const receipt = {
    scenario: name,
    socketsOpened: sockets.length,
    socketsClosed: sockets.filter((socket) => socket.readyState === WebSocket.CLOSED).length,
    fakeExited: instances.length > 0 && instances.every((instance) => instance.killCount === 1),
    subscriptionsClosed: cleanup.subscriptionCloseDelta > 0,
    subscriptionCloseDelta: cleanup.subscriptionCloseDelta,
    stateDirAbsent,
    stoppedPortHandshakeFailed,
    pendingWaitersSettled: outcomes.every((outcome) => outcome.status === "fulfilled"),
  };
  receipts.push(receipt);
  expect(receipt.socketsClosed).toBe(receipt.socketsOpened);
  expect(receipt.fakeExited).toBe(true);
  expect(receipt.subscriptionsClosed).toBe(true);
  expect(receipt.stateDirAbsent).toBe(true);
  expect(receipt.stoppedPortHandshakeFailed).toBe(true);
  expect(receipt.pendingWaitersSettled).toBe(true);
  const directory = evidenceDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "backpressure-stall.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  await writeFile(resolve(directory, "backpressure-stall-cleanup.json"), `${JSON.stringify({ cases: receipts }, null, 2)}\n`, "utf8");
}

const ackAttach = (pane: string) => JSON.stringify({ type: "attach", pane_id: pane, cols: 100, rows: 30, flow_control: "ack" });

test("S7 ACK credit releases only at exact low watermark", async () => {
  const harness = await createServerHarness();
  const pending: Promise<unknown>[] = [];
  const socket = harness.openSocket();
  let exited: Promise<void> | undefined;
  try {
    const open = waitOpen(harness, socket); pending.push(open); await open;
    harness.queueInitialPtyOutput("S7-START");
    const initial = waitMessage(socket, (frame) => frame["type"] === "pty-data", "initial output missing");
    const ready = waitMessage(socket, (frame) => frame["type"] === "pane-geometry" || frame["type"] === "pty-data", "attach response missing");
    socket.send(ackAttach(harness.paneId));
    const attachReply = await ready;
    const initialFrame = attachReply["type"] === "pty-data" ? attachReply : await initial;
    const highFrameWait = waitMessage(socket, (frame) => frame["type"] === "pty-data", "high watermark output missing");
    const pause = harness.waitForPtyEvent(harness.paneId, "pause"); pending.push(pause.promise);
    const pty = harness.instances.at(-1);
    if (!pty) throw new Error("attach did not create a fake PTY");
    exited = pty.exited;
    const body = "H".repeat(OUTPUT_HIGH_BYTES);
    harness.emitPtyData(harness.paneId, body);
    const high = await highFrameWait;
    await pause.promise;
    expect(initialFrame["data"]).toBe("S7-START");
    expect(high["data"]).toBe(body);
    const streamId = typeof high["flow"] === "object" && high["flow"] !== null && "stream_id" in high["flow"] ? high["flow"].stream_id : undefined;
    const sentOffset = typeof high["flow"] === "object" && high["flow"] !== null && "offset" in high["flow"] ? high["flow"].offset : undefined;
    if (typeof streamId !== "string" || typeof sentOffset !== "number") throw new Error("high watermark frame omitted flow fields");
    expect(sentOffset).toBe(new TextEncoder().encode(`S7-START${body}`).byteLength);
    const before = pty.resumeCount;
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: streamId, offset: sentOffset - OUTPUT_LOW_BYTES - 1 }));
    expect(pty.resumeCount).toBe(before);
    const invalid = waitMessage(socket, (frame) => frame["type"] === "error", "future ACK error missing");
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: streamId, offset: sentOffset + 1 }));
    expect((await invalid)["code"]).toBe("invalid_ack");
    expect(pty.resumeCount).toBe(before);
    const resume = harness.waitForPtyEvent(harness.paneId, "resume"); pending.push(resume.promise);
    const sentinelWait = waitMessage(socket, (frame) => frame["type"] === "pty-data" && frame["data"] === "FLOW_RESUMED", "resume sentinel missing");
    harness.queuePtyOutputOnResume(harness.paneId, "FLOW_RESUMED");
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: streamId, offset: sentOffset - OUTPUT_LOW_BYTES }));
    await resume.promise;
    const sentinel = await sentinelWait;
    expect(pty.resumeCount).toBe(before + 1);
    const sentinelFlow = sentinel["flow"];
    if (typeof sentinelFlow !== "object" || sentinelFlow === null || !("offset" in sentinelFlow)) throw new Error("resume sentinel omitted its offset");
    expect(sentinelFlow.offset).toBe(sentOffset + new TextEncoder().encode("FLOW_RESUMED").byteLength);
    records.push({ scenario: "S7", sentOffset, pendingAboveLow: OUTPUT_LOW_BYTES + 1, invalidAck: "invalid_ack", pendingAtResume: OUTPUT_LOW_BYTES, resumed: true, sentinelOffset: sentinelFlow.offset });
  } finally { await finish("S7", harness, [socket], pending, exited); }
});

test("S8 stalled observer is evicted while operator receives live output", async () => {
  const harness = await createServerHarness();
  const pending: Promise<unknown>[] = [];
  const operator = harness.openSocket();
  let observer: WebSocket | undefined;
  let exited: Promise<void> | undefined;
  try {
    harness.queueInitialPtyOutput("S8-START");
    const operatorOpen = waitOpen(harness, operator); pending.push(operatorOpen); await operatorOpen;
    const operatorInitial = waitMessage(operator, (frame) => frame["type"] === "pty-data", "operator initial output missing");
    const operatorReady = waitMessage(operator, (frame) => frame["type"] === "pane-geometry" || frame["type"] === "pty-data", "operator attach missing");
    operator.send(ackAttach(harness.paneId)); await operatorReady;
    const operatorSeed = await operatorInitial;
    observer = harness.openSocket();
    const observerOpen = waitOpen(harness, observer); pending.push(observerOpen); await observerOpen;
    const role = waitMessage(observer, (frame) => frame["type"] === "role-ack", "observer role ACK missing");
    observer.send(JSON.stringify({ type: "role", mode: "observe" })); await role;
    const observerInitial = waitMessage(observer, (frame) => frame["type"] === "pty-data", "observer initial output missing");
    const observerReady = waitMessage(observer, (frame) => frame["type"] === "pane-geometry" || frame["type"] === "pty-data", "observer attach missing");
    observer.send(ackAttach(harness.paneId)); const observerReply = await observerReady;
    const observerClosed = new Promise<CloseEvent>((resolvePromise, rejectPromise) => {
      const onClose = (event: CloseEvent) => { clearTimeout(timer); observer?.removeEventListener("close", onClose); resolvePromise(event); };
      const timer = setTimeout(() => { observer?.removeEventListener("close", onClose); rejectPromise(new Error("timed out waiting for observer close")); }, timeoutMs);
      observer?.addEventListener("close", onClose, { once: true });
    });
    pending.push(observerClosed);
    const observerBytes = { value: 0 };
    const observerData = (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== "pty-data" || !("data" in parsed)) return;
      observerBytes.value += new TextEncoder().encode(String(parsed.data)).byteLength;
    };
    observer.addEventListener("message", observerData);
    if (observerReply["type"] === "pty-data" && "data" in observerReply) observerBytes.value += new TextEncoder().encode(String(observerReply["data"])).byteLength;
    else {
      const seed = await observerInitial;
      observerBytes.value += new TextEncoder().encode(String(seed["data"])).byteLength;
    }
    const alive = waitMessage(operator, (frame) => frame["type"] === "pty-data" && frame["data"] === "FLOW_ALIVE", "FLOW_ALIVE missing", 15000);
    const operatorOutput = waitMessage(operator, (frame) => frame["type"] === "pty-data" && frame["data"] === "O".repeat(OUTPUT_HIGH_BYTES), "operator output missing");
    const pty = harness.instances.at(-1);
    if (!pty) throw new Error("operator attach did not create a fake PTY");
    exited = pty.exited;
    const resume = harness.waitForPtyEvent(harness.paneId, "resume"); pending.push(resume.promise);
    harness.queuePtyOutputOnResume(harness.paneId, "FLOW_ALIVE");
    const pause = harness.waitForPtyEvent(harness.paneId, "pause"); pending.push(pause.promise);
    harness.emitPtyData(harness.paneId, "O".repeat(OUTPUT_HIGH_BYTES));
    await pause.promise;
    const operatorFrame = await operatorOutput;
    expect(operatorFrame["data"]).toBe("O".repeat(OUTPUT_HIGH_BYTES));
    const operatorFlow = operatorFrame["flow"];
    if (typeof operatorFlow !== "object" || operatorFlow === null || !("stream_id" in operatorFlow) || !("offset" in operatorFlow)) throw new Error("operator frame omitted flow state");
    operator.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: operatorFlow.stream_id, offset: operatorFlow.offset }));
    const close = await observerClosed;
    expect(close.code).toBe(closeCodeStalled);
    expect(observerBytes.value).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
    expect(operator.readyState).toBe(WebSocket.OPEN);
    await resume.promise;
    const live = await alive;
    expect(live["data"]).toBe("FLOW_ALIVE");
    expect(operator.readyState).toBe(WebSocket.OPEN);
    observer.removeEventListener("message", observerData);
    records.push({ scenario: "S8", observerCloseCode: close.code, observerBytes: observerBytes.value, hardLimit: OUTPUT_HARD_BYTES, operatorOpen: true, flowAlive: live["data"], operatorSeed: operatorSeed["data"] });
  } finally {
    await finish("S8", harness, observer ? [operator, observer] : [operator], pending, exited);
  }
}, OUTPUT_STALL_MS + 12000);

test("S9 output beyond hard limit closes before frame and kills PTY once", async () => {
  const harness = await createServerHarness();
  const pending: Promise<unknown>[] = [];
  const socket = harness.openSocket();
  let exited: Promise<void> | undefined;
  try {
    const open = waitOpen(harness, socket); pending.push(open); await open;
    harness.queueInitialPtyOutput("S9-START");
    const ready = waitMessage(socket, (frame) => frame["type"] === "pane-geometry" || frame["type"] === "pty-data", "attach response missing");
    const initial = waitMessage(socket, (frame) => frame["type"] === "pty-data", "initial PTY data missing");
    socket.send(ackAttach(harness.paneId)); const attachReply = await ready;
    if (attachReply["type"] !== "pty-data") await initial;
    const closeWait = waitClose(socket); pending.push(closeWait);
    const pty = harness.instances.at(-1);
    if (!pty) throw new Error("attach did not create a fake PTY");
    exited = pty.exited;
    const kill = harness.waitForPtyEvent(harness.paneId, "kill"); pending.push(kill.promise);
    let ptyDataDelivered = false;
    let firstPtyDataBeforeClose: boolean | undefined;
    const onPtyData = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (frame["type"] === "pty-data") {
        ptyDataDelivered = true;
        firstPtyDataBeforeClose ??= socket.readyState !== WebSocket.CLOSED;
      }
    };
    socket.addEventListener("message", onPtyData);
    harness.emitPtyData(harness.paneId, "X".repeat(OUTPUT_HARD_BYTES + 1));
    const [close] = await Promise.all([closeWait, kill.promise, exited]);
    socket.removeEventListener("message", onPtyData);
    expect(close.code).toBe(closeCodeStalled);
    expect(ptyDataDelivered).toBe(false);
    expect(firstPtyDataBeforeClose).toBeUndefined();
    expect(pty.killCount).toBe(1);
    records.push({ scenario: "S9", emittedBytes: OUTPUT_HARD_BYTES + 1, oversizedFrameDelivered: false, closeCode: close.code, killCount: pty.killCount });
  } finally { await finish("S9", harness, [socket], pending, exited); }
});
