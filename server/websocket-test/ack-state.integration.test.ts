import { expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServerHarness, evidenceDirectory } from "./create-server-harness.ts";

const records: Record<string, unknown>[] = [];
const cleanupReceipts: Record<string, unknown>[] = [];

async function saveEvidence(): Promise<void> {
  const directory = evidenceDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "ack-state.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(resolve(directory, "ack-state-cleanup.json"), JSON.stringify(cleanupReceipts, null, 2) + "\n");
}

function message(socket: WebSocket): Promise<Record<string, unknown>> {
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
        const parsed: unknown = JSON.parse(String(event.data));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("websocket frame must be an object");
        resolvePromise(parsed as Record<string, unknown>);
      } catch (error) {
        rejectPromise(error);
      }
    };
    const onClose = () => { cleanup(); rejectPromise(new Error("websocket closed before a frame arrived")); };
    const onError = () => { cleanup(); rejectPromise(new Error("websocket errored before a frame arrived")); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error("timed out waiting for websocket message")); }, 5000);
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function errors(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const frames: Record<string, unknown>[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      const frame: unknown = JSON.parse(String(event.data));
      if (typeof frame !== "object" || frame === null || Array.isArray(frame) || !("type" in frame) || frame.type !== "error") return;
      frames.push(frame as Record<string, unknown>);
      if (frames.length !== count) return;
      cleanup();
      resolvePromise(frames);
    };
    const onClose = () => { cleanup(); rejectPromise(new Error("websocket closed before error frames arrived")); };
    const onError = () => { cleanup(); rejectPromise(new Error("websocket errored before error frames arrived")); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error("timed out waiting for error frames")); }, 5000);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

async function startSocket(harness: Awaited<ReturnType<typeof createServerHarness>>): Promise<WebSocket> {
  const socket = harness.openSocket();
  const opened = harness.prearmSocketEvent("open");
  const snapshot = message(socket);
  const [, frame] = await Promise.all([opened, snapshot]);
  expect(frame["type"]).toBe("snapshot");
  return socket;
}

async function clean(harness: Awaited<ReturnType<typeof createServerHarness>>, socket: WebSocket): Promise<void> {
  const instance = harness.instances[0];
  const stateDir = harness.stateDir;
  const port = Number(new URL(harness.baseUrl).port);
  const closing = harness.prearmSocketEvent("close");
  const result = await harness.cleanup();
  await instance?.exited;
  const stoppedPortHandshakeFailed = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true);
  const stateDirAbsent = await stat(stateDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  cleanupReceipts.push({
    socketClosed: (await closing).socket === socket,
    fakeExited: instance !== undefined && instance.killCount === 1,
    subscriptionCloseDelta: result.subscriptionCloseDelta,
    stateDirAbsent,
    stoppedPortHandshakeFailed,
  });
  expect(stateDirAbsent).toBe(true);
  expect(stoppedPortHandshakeFailed).toBe(true);
  expect(instance).toBeDefined();
  if (!instance) throw new Error("attached pane did not create a fake PTY session");
  expect(instance.killCount).toBe(1);
  expect(result.subscriptionCloseDelta).toBeGreaterThanOrEqual(1);
  await saveEvidence();
}

test("S2 cumulative and duplicate ACKs preserve output credit", async () => {
  const harness = await createServerHarness();
  let socket: WebSocket | undefined;
  try {
    socket = await startSocket(harness);
    const roleAck = message(socket);
    socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    expect((await roleAck)["type"]).toBe("role-ack");
    const readyFrame = message(socket);
    socket.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 120, rows: 40, flow_control: "ack" }));
    expect((await readyFrame)["type"]).toBe("pane-geometry");
    const initialPause = harness.waitForPtyEvent(harness.paneId, "pause");
    const initialFrame = message(socket);
    harness.emitPtyData(harness.paneId, "A".repeat(300000));
    const [first, pauseEvent] = await Promise.all([initialFrame, initialPause.promise]);
    const instance = harness.instances.at(-1);
    expect(first["type"]).toBe("pty-data");
    const firstFlow = first["flow"];
    if (typeof firstFlow !== "object" || firstFlow === null || !("offset" in firstFlow) || !("stream_id" in firstFlow)) throw new Error("first output frame omitted flow data");
    expect(firstFlow.offset).toBe(300000);
    expect(first["data"]).toBe("A".repeat(300000));
    expect(pauseEvent.type).toBe("pause");
    const resume = harness.waitForPtyEvent(harness.paneId, "resume");
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: firstFlow.stream_id, offset: 300000 }));
    const resumeEvent = await resume.promise.catch((error) => { throw new Error(`resume after cumulative ACK: ${String(error)}`); });
    expect(resumeEvent.type).toBe("resume");
    const nextFrame = message(socket);
    const afterFullAckResumeCount = instance?.resumeCount;
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: firstFlow.stream_id, offset: 300000 }));
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: firstFlow.stream_id, offset: 100000 }));
    const messageWaiter = message(socket);
    harness.emitPtyData(harness.paneId, "B".repeat(63000));
    const second = await nextFrame;
    const duplicateAndRegressiveResult = await messageWaiter;
    expect(duplicateAndRegressiveResult["type"]).not.toBe("error");
    expect(second["type"]).toBe("pty-data");
    const secondFlow = second["flow"];
    if (typeof secondFlow !== "object" || secondFlow === null || !("offset" in secondFlow)) throw new Error("second output frame omitted offset");
    expect(secondFlow.offset).toBe(363000);
    expect(second["data"]).toBe("B".repeat(63000));
    expect(instance?.pauseCount).toBe(1);
    expect(instance?.resumeCount).toBe(afterFullAckResumeCount);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    records.push({ scenario: "S2", actions: ["attach ack", "emit A×300000", "ack 300000", "ack 100000", "emit B×63000"], frames: [first, second], pauseCount: instance?.pauseCount, resumeCount: instance?.resumeCount, socketOpen: socket.readyState === WebSocket.OPEN });
    await clean(harness, socket);
  } finally {
    if (socket && harness.instances[0]?.killCount === 0) {
      const close = harness.prearmSocketEvent("close");
      await harness.cleanup();
      await close;
      await harness.instances[0]?.exited;
    }
  }
});

test("S3 future and malformed ACK offsets return invalid_ack", async () => {
  const harness = await createServerHarness();
  let socket: WebSocket | undefined;
  try {
    harness.queueInitialPtyOutput("ack-probe");
    socket = await startSocket(harness);
    const initialFrame = message(socket);
    socket.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 120, rows: 40, flow_control: "ack" }));
    const data = await initialFrame;
    expect(data["data"]).toBe("ack-probe");
    const instance = harness.instances.at(-1);
    if (!instance) throw new Error("attach did not create a fake PTY session");
    const errorFrames = errors(socket, 2);
    const flow = data["flow"];
    if (typeof flow !== "object" || flow === null || !("stream_id" in flow)) throw new Error("output frame omitted stream id");
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: flow.stream_id, offset: Number.MAX_SAFE_INTEGER }));
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: flow.stream_id, offset: "not-a-number" }));
    const errorFramesResult = await errorFrames;
    expect(errorFramesResult.map((frame) => frame["code"])).toEqual(["invalid_ack", "invalid_ack"]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(instance.resumeCount).toBe(0);
    expect(instance.pauseCount).toBe(0);
    records.push({ scenario: "S3", actions: ["attach ack with ack-probe", "ack Number.MAX_SAFE_INTEGER", "ack string not-a-number"], frames: [data, ...errorFramesResult], pauseCount: instance.pauseCount, resumeCount: instance.resumeCount, socketOpen: socket.readyState === WebSocket.OPEN });
    await clean(harness, socket);
  } finally {
    if (socket && harness.instances[0]?.killCount === 0) {
      const close = harness.prearmSocketEvent("close");
      await harness.cleanup();
      await close;
      await harness.instances[0]?.exited;
    }
  }
});
