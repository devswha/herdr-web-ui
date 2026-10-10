import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createServerHarness, websocketRunRoot } from "./create-server-harness.ts";
import { onPtyEvent } from "./fake-pty-session.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_LOW_BYTES } from "../output-window.ts";

const evidencePath = join(websocketRunRoot, "evidence", "ack-replay.jsonl");
const cleanupPath = join(websocketRunRoot, "evidence", "ack-replay-cleanup.json");

interface WsFrame { readonly type: string; readonly [key: string]: unknown }

function message(socket: WebSocket, diagnostic: string): Promise<WsFrame> {
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
      const parsed: unknown = JSON.parse(String(event.data));
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
        rejectPromise(new Error("WebSocket frame has no string type"));
        return;
      }
      resolvePromise(parsed as WsFrame);
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, 5000);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

test("real replay preserves UTF-8 offsets and ACK resumes output", async () => {
  const harness = await createServerHarness();
  let socket: WebSocket | undefined;
  let fakeExited: Promise<void> | undefined;
  let exitEvent: Promise<void> | undefined;
  let unsubscribeExit: (() => void) | undefined;
  const waits: Promise<unknown>[] = [];
  let outcome: Record<string, unknown> = { case: "ack-replay", passed: false };
  try {
    await mkdir(join(websocketRunRoot, "evidence"), { recursive: true });
    harness.queueInitialPtyOutput("\x1b[?1049h\x1b[?1000h" + "한🙂".repeat(40000));
    socket = harness.openSocket();
    const openWait = harness.prearmSocketEvent("open");
    const snapshotWait = message(socket, "timed out waiting for initial snapshot");
    waits.push(openWait, snapshotWait);
    const [opened, snapshot] = await Promise.all([openWait, snapshotWait]);
    expect(opened.socket).toBe(socket);
    expect(snapshot.type).toBe("snapshot");

    const pauseWait = harness.waitForPtyEvent("fake-pane", "pause");
    const replayWait = message(socket, "timed out waiting for replay frame");
    waits.push(pauseWait.promise, replayWait);
    exitEvent = new Promise<void>((resolvePromise) => {
      const unsubscribe = onPtyEvent((event) => {
        if (event.type !== "exit") return;
        unsubscribe();
        resolvePromise();
      });
      unsubscribeExit = unsubscribe;
    });
    socket.send('{"type":"attach","pane_id":"fake-pane","cols":100,"rows":30,"flow_control":"ack"}');
    fakeExited = harness.instances.at(-1)?.exited;
    const [pause, frame] = await Promise.all([pauseWait.promise, replayWait]);
    expect(pause.type).toBe("pause");
    expect(frame.type).toBe("pty-data");
    const data = String(frame.data);
    const flow = frame.flow;
    if (typeof flow !== "object" || flow === null || !("stream_id" in flow) || !("offset" in flow)) throw new Error("replay frame omitted flow metadata");
    const offset = Number(flow.offset);
    expect(String(flow.stream_id).length).toBeGreaterThan(0);
    expect(offset).toBe(Buffer.byteLength(data));
    expect(data).toContain("\x1b[?1049h");
    expect(data).toContain("\x1b[?1000h");
    expect(offset).toBeLessThan(OUTPUT_HARD_BYTES);

    harness.queuePtyOutputOnResume("fake-pane", "ACK_RESUMED");
    const nextDataWait = message(socket, "timed out waiting for resumed sentinel");
    const resumeWait = harness.waitForPtyEvent("fake-pane", "resume");
    waits.push(nextDataWait, resumeWait.promise);
    socket.send(JSON.stringify({ type: "pty-ack", pane_id: "fake-pane", stream_id: flow.stream_id, offset: offset - OUTPUT_LOW_BYTES }));
    const [resume, nextFrame] = await Promise.all([resumeWait.promise, nextDataWait]);
    expect(resume.type).toBe("resume");
    expect(nextFrame.type).toBe("pty-data");
    const sentinelData = String(nextFrame.data);
    expect(sentinelData).toContain("ACK_RESUMED");
    const nextFlow = nextFrame.flow;
    if (typeof nextFlow !== "object" || nextFlow === null || !("offset" in nextFlow)) throw new Error("sentinel frame omitted flow offset");
    const resumedBytes = Number(nextFlow.offset);
    expect(resumedBytes).toBe(offset + Buffer.byteLength(sentinelData));
    outcome = { case: "ack-replay", passed: true, replayBytes: offset, replayContainsModes: true, hardBytes: OUTPUT_HARD_BYTES, ackOffset: offset - OUTPUT_LOW_BYTES, resumedBytes, sentinel: "ACK_RESUMED" };
  } finally {
    const stateDir = harness.stateDir;
    const sessionExit = fakeExited ?? harness.instances.at(-1)?.exited;
    let cleanupResult: Awaited<ReturnType<typeof harness.cleanup>> | undefined;
    let fakeExitedResolved = false;
    try {
      cleanupResult = await harness.cleanup();
      await Promise.allSettled(waits);
      if (sessionExit) {
        await sessionExit;
        fakeExitedResolved = true;
        if (exitEvent) await exitEvent;
      }
      unsubscribeExit?.();
      let stateDirAbsent = false;
      try {
        await access(stateDir);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") stateDirAbsent = true;
        else throw error;
      }
      const stoppedPortHandshakeFailed = await new Promise<boolean>((resolvePromise, rejectPromise) => {
        const stopped = new WebSocket(new URL("/ws", harness.baseUrl));
        const timer = setTimeout(() => { stopped.close(); rejectPromise(new Error("stopped-port handshake did not settle")); }, 1000);
        const settle = (failed: boolean) => {
          clearTimeout(timer);
          stopped.removeEventListener("error", onError);
          stopped.removeEventListener("open", onOpen);
          if (failed) resolvePromise(true);
          else { stopped.close(); resolvePromise(false); }
        };
        const onError = () => settle(true);
        const onOpen = () => settle(false);
        stopped.addEventListener("error", onError);
        stopped.addEventListener("open", onOpen);
      });
      const receipt = {
        case: "ack-replay",
        socketsClosed: socket?.readyState === WebSocket.CLOSED ? 1 : 0,
        fakeExitedResolved,
        subscriptionCloseDelta: cleanupResult.subscriptionCloseDelta,
        subscriptionsClosed: cleanupResult.subscriptionCloseDelta > 0,
        stateDirAbsent,
        stoppedPortHandshakeFailed,
      };
      await writeFile(evidencePath, `${JSON.stringify(outcome)}\n`, "utf8");
      await writeFile(cleanupPath, `${JSON.stringify({ cases: [receipt] }, null, 2)}\n`, "utf8");
      expect(receipt.socketsClosed).toBe(socket ? 1 : 0);
      expect(receipt.fakeExitedResolved).toBe(true);
      expect(receipt.subscriptionsClosed).toBe(true);
      expect(receipt.stateDirAbsent).toBe(true);
      expect(receipt.stoppedPortHandshakeFailed).toBe(true);
    } finally {
      if (cleanupResult === undefined) {
        await harness.cleanup();
        unsubscribeExit?.();
      }
    }
  }
}, 15000);
