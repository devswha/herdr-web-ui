import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { createServerHarness, resolveContainedPath, websocketRunRoot } from "./create-server-harness.ts";
import { onPtyEvent } from "./fake-pty-session.ts";

const evidencePath = join(websocketRunRoot, "evidence", "smoke-ws.jsonl");
const cleanupPath = join(websocketRunRoot, "evidence", "smoke-ws-cleanup.json");
const attachMessage = '{"type":"attach","pane_id":"fake-pane","cols":100,"rows":30,"flow_control":"ack"}';
const noOutputDiagnostic = "timed out waiting for WebSocket message after attach (no-output guard)";
const records: string[] = [];
const cleanupCases: { readonly case: string; readonly socketsClosed: number; readonly fakeExitedResolved: boolean; readonly subscriptionsClosed: boolean; readonly stateDirAbsent: boolean; readonly stoppedPortHandshakeFailed: boolean }[] = [];

await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, "", "utf8");
await writeFile(cleanupPath, "", "utf8");

interface WsFrame { readonly type: string; readonly [key: string]: unknown }

function boundedMessage(socket: WebSocket, timeoutMs: number, diagnostic: string): Promise<WsFrame> {
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
      const frame = parsed as WsFrame;
      // Upstream announces an attachment's readiness with a broadcast input-ready frame; it is not scenario data.
      if (frame.type === "input-ready") {
        socket.addEventListener("message", onMessage);
        return;
      }
      resolvePromise(frame);
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function boundedNoOutputMessage(socket: WebSocket): Promise<WsFrame> {
  return boundedMessage(socket, 1000, noOutputDiagnostic);
}

async function finishCase(
  harness: Awaited<ReturnType<typeof createServerHarness>>,
  socket: WebSocket | undefined,
  caseName: string,
  fakeExited: Promise<void> | undefined,
  exitEvent: Promise<void> | undefined,
  unsubscribeExit: (() => void) | undefined,
  socketWaits: Promise<unknown>[],
): Promise<void> {
  const stateDir = harness.stateDir;
  const sessionExit = fakeExited ?? harness.instances.at(-1)?.exited;
  const settledSocketWaits = Promise.allSettled(socketWaits);
  let cleanupResult: Awaited<ReturnType<typeof harness.cleanup>> | undefined;
  let fakeExitedResolved = false;
  try {
    cleanupResult = await harness.cleanup();
    await settledSocketWaits;
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
    const subscriptionsClosed = cleanupResult.subscriptionCloseDelta > 0;
    const stateDirUnderRunRoot = resolveContainedPath(stateDir, stateDir) === stateDir;
    const cleanupCase = { case: caseName, socketsClosed: socket?.readyState === WebSocket.CLOSED ? 1 : 0, fakeExitedResolved, subscriptionsClosed, stateDirAbsent, stoppedPortHandshakeFailed };
    cleanupCases.push(cleanupCase);
    const priorJsonl = await Bun.file(evidencePath).text();
    await writeFile(evidencePath, `${priorJsonl}${records.splice(0).join("\n")}\n`, "utf8");
    await writeFile(cleanupPath, `${JSON.stringify({ cases: cleanupCases }, null, 2)}\n`, "utf8");
    expect(stateDirUnderRunRoot).toBe(true);
    expect(cleanupCase.socketsClosed).toBe(socket ? 1 : 0);
    expect(cleanupCase.fakeExitedResolved).toBe(true);
    expect(cleanupCase.subscriptionsClosed).toBe(true);
    expect(cleanupCase.stateDirAbsent).toBe(true);
    expect(cleanupCase.stoppedPortHandshakeFailed).toBe(true);
  } finally {
    if (cleanupResult === undefined) {
      await harness.cleanup();
      unsubscribeExit?.();
    }
  }
}

test("real localhost attach replays queued PTY output", async () => {
  const harness = await createServerHarness();
  let socket: WebSocket | undefined;
  let fakeExited: Promise<void> | undefined;
  let exitEvent: Promise<void> | undefined;
  let unsubscribeExit: (() => void) | undefined;
  const socketWaits: Promise<unknown>[] = [];
  try {
    expect(resolveContainedPath(harness.stateDir, harness.stateDir)).toBe(harness.stateDir);
    harness.queueInitialPtyOutput("SMOKE");
    socket = harness.openSocket();
    const openWait = harness.prearmSocketEvent("open");
    const snapshotWait = boundedMessage(socket, 5000, "timed out waiting for initial snapshot");
    socketWaits.push(openWait);
    socketWaits.push(snapshotWait);
    const [openEvent, snapshotFrame] = await Promise.all([openWait, snapshotWait]);
    expect(openEvent.socket).toBe(socket);
    expect(snapshotFrame.type).toBe("snapshot");
    const frameWait = boundedMessage(socket, 5000, "timed out waiting for PTY output after attach");
    socketWaits.push(frameWait);
    exitEvent = new Promise<void>((resolvePromise) => {
      const unsubscribe = onPtyEvent((event) => {
        if (event.type !== "exit") return;
        unsubscribe();
        resolvePromise();
      });
      unsubscribeExit = unsubscribe;
    });
    socket.send(attachMessage);
    fakeExited = harness.instances.at(-1)?.exited;
    const frame = await frameWait;
    expect(frame.type).toBe("pty-data");
    expect(frame.data).toContain("SMOKE");
    const data = String(frame.data);
    const flow = frame.flow;
    expect(typeof flow).toBe("object");
    expect(flow).not.toBeNull();
    if (typeof flow !== "object" || flow === null || !("offset" in flow)) throw new Error("pty-data frame omitted flow offset");
    const utf8ByteOffset = Number(flow.offset);
    expect(utf8ByteOffset).toBe(new TextEncoder().encode(data.slice(0, data.indexOf("SMOKE") + "SMOKE".length)).byteLength);
    records.push(JSON.stringify({ case: "attach-with-output", snapshot: true, ptyData: true, data, utf8ByteOffset }));
  } finally {
    await finishCase(harness, socket, "attach-with-output", fakeExited, exitEvent, unsubscribeExit, socketWaits);
  }
}, 15000);

test("no-output attach reports bounded diagnostic and still cleans up", async () => {
  const harness = await createServerHarness();
  let socket: WebSocket | undefined;
  let fakeExited: Promise<void> | undefined;
  let exitEvent: Promise<void> | undefined;
  let unsubscribeExit: (() => void) | undefined;
  const socketWaits: Promise<unknown>[] = [];
  try {
    socket = harness.openSocket();
    const openWait = harness.prearmSocketEvent("open");
    const snapshotWait = boundedMessage(socket, 5000, "timed out waiting for initial snapshot");
    socketWaits.push(openWait);
    socketWaits.push(snapshotWait);
    const [openEvent, snapshot] = await Promise.all([openWait, snapshotWait]);
    expect(openEvent.socket).toBe(socket);
    expect(snapshot.type).toBe("snapshot");
    const message = boundedNoOutputMessage(socket);
    socketWaits.push(message);
    exitEvent = new Promise<void>((resolvePromise) => {
      const unsubscribe = onPtyEvent((event) => {
        if (event.type !== "exit") return;
        unsubscribe();
        resolvePromise();
      });
      unsubscribeExit = unsubscribe;
    });
    socket.send(attachMessage);
    fakeExited = harness.instances.at(-1)?.exited;
    await expect(message).rejects.toThrow(noOutputDiagnostic);
    records.push(JSON.stringify({ case: "attach-without-output", snapshot: true, ptyData: false, diagnostic: noOutputDiagnostic }));
  } finally {
    await finishCase(harness, socket, "attach-without-output", fakeExited, exitEvent, unsubscribeExit, socketWaits);
  }
}, 15000);
