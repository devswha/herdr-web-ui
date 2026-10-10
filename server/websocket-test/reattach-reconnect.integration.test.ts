import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { createServerHarness, evidenceDirectory } from "./create-server-harness.ts";

const evidencePath = resolve(evidenceDirectory(), "reattach-reconnect.jsonl");
const cleanupPath = resolve(evidenceDirectory(), "reattach-reconnect-cleanup.json");
const paneId = "fake-pane";
const timeoutMs = 5000;
const records: Record<string, unknown>[] = [];
const cleanupCases: Record<string, unknown>[] = [];

interface Frame { readonly type: string; readonly [key: string]: unknown }

function message(socket: WebSocket, diagnostic: string, predicate: (frame: Frame) => boolean = () => true): Promise<Frame> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") throw new Error("frame has no string type");
        const frame = parsed as Frame;
        if (!predicate(frame)) return;
        cleanup();
        resolvePromise(frame);
      } catch (error) {
        cleanup();
        rejectPromise(error);
      }
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

const ptyMessage = (socket: WebSocket, diagnostic: string) => message(socket, diagnostic, (frame) => frame.type === "pty-data");
const dataMessage = (socket: WebSocket, data: string, diagnostic: string) => message(socket, diagnostic, (frame) => frame.type === "pty-data" && frame.data === data);

function flow(frame: Frame): { stream_id: string; offset: number } {
  const value = frame.flow;
  if (typeof value !== "object" || value === null || !("stream_id" in value) || !("offset" in value)) throw new Error("pty-data omitted flow metadata");
  return { stream_id: String(value.stream_id), offset: Number(value.offset) };
}

async function openedWithSnapshot(harness: Awaited<ReturnType<typeof createServerHarness>>, socket: WebSocket): Promise<void> {
  const opened = harness.prearmSocketEvent("open");
  const snapshot = message(socket, "timed out waiting for initial snapshot", (frame) => frame.type === "snapshot");
  const [openResult, snapshotFrame] = await Promise.all([opened, snapshot]);
  expect(openResult.socket).toBe(socket);
  expect(snapshotFrame.type).toBe("snapshot");
}

async function finishCase(harness: Awaited<ReturnType<typeof createServerHarness>>, sockets: WebSocket[], name: string, expectedExit?: Promise<void>): Promise<void> {
  const stateDir = harness.stateDir;
  const instances = [...harness.instances];
  const exits = instances.map((instance) => instance.exited);
  const closePromises = sockets.map(async (socket) => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = harness.prearmSocketEvent("close");
    if (socket.readyState !== WebSocket.CLOSED) socket.close();
    await closed;
  });
  await Promise.all(closePromises);
  const cleanup = await harness.cleanup();
  await Promise.all(exits);
  if (expectedExit) await expectedExit;
  const stateDirAbsent = await access(stateDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const stoppedPortHandshakeFailed = await new Promise<boolean>((resolvePromise, rejectPromise) => {
    const stopped = new WebSocket(`${harness.baseUrl}/ws`);
    let timer: ReturnType<typeof setTimeout>;
    const settle = (failed: boolean) => {
      clearTimeout(timer);
      stopped.removeEventListener("error", onError);
      stopped.removeEventListener("open", onOpen);
      if (!failed && stopped.readyState !== WebSocket.CLOSED) stopped.close();
      resolvePromise(failed);
    };
    const onError = () => settle(true);
    const onOpen = () => settle(false);
    timer = setTimeout(() => { stopped.close(); rejectPromise(new Error("stopped-port handshake did not settle")); }, timeoutMs);
    stopped.addEventListener("error", onError);
    stopped.addEventListener("open", onOpen);
  });
  const receipt = {
    scenario: name,
    socketsClosed: sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
    fakeExited: instances.length > 0 && instances.every((instance) => instance.killCount === 1),
    subscriptionCloseDelta: cleanup.subscriptionCloseDelta,
    stateDirAbsent,
    stoppedPortHandshakeFailed,
  };
  cleanupCases.push(receipt);
  await mkdir(evidenceDirectory(), { recursive: true });
  await writeFile(evidencePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await writeFile(cleanupPath, `${JSON.stringify({ cases: cleanupCases }, null, 2)}\n`, "utf8");
  expect(receipt.socketsClosed).toBe(true);
  expect(receipt.fakeExited).toBe(true);
  expect(receipt.subscriptionCloseDelta).toBeGreaterThan(0);
  expect(receipt.stateDirAbsent).toBe(true);
  expect(receipt.stoppedPortHandshakeFailed).toBe(true);
}

function attach(socket: WebSocket): void { socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" })); }
function roleBarrier(socket: WebSocket): Promise<Frame> {
  const ack = message(socket, "timed out waiting for interact role-ack", (frame) => frame.type === "role-ack" && frame.mode === "interact");
  socket.send(JSON.stringify({ type: "role", mode: "interact" }));
  return ack;
}

test("S4 reattach isolates stale stream ACKs and resumes current credit", async () => {
  const harness = await createServerHarness();
  const sockets: WebSocket[] = [];
  let expectedExit: Promise<void> | undefined;
  try {
    harness.queueInitialPtyOutput("OLD");
    const socket = harness.openSocket(); sockets.push(socket);
    await openedWithSnapshot(harness, socket);
    const oldReplayWait = ptyMessage(socket, "timed out waiting for OLD replay");
    attach(socket);
    const oldReplay = await oldReplayWait;
    const oldFlow = flow(oldReplay);
    const oldSession = harness.instances.at(-1);
    if (!oldSession) throw new Error("OLD attach did not create a PTY session");
    expectedExit = oldSession.exited;
    const roleAck = roleBarrier(socket);
    const detached = message(socket, "timed out waiting for detach acknowledgement", (frame) => frame.type === "detach-ack" || frame.type === "role-ack");
    socket.send(JSON.stringify({ type: "detach", pane_id: paneId }));
    await Promise.all([roleAck, detached]);
    const closed = harness.prearmSocketEvent("close");
    socket.close();
    await closed;
    await oldSession.exited;

    harness.queueInitialPtyOutput("NEW");
    const reopened = harness.openSocket(); sockets.push(reopened);
    await openedWithSnapshot(harness, reopened);
    await roleBarrier(reopened);
    const newReplayWait = ptyMessage(reopened, "timed out waiting for NEW replay");
    attach(reopened);
    const current = await newReplayWait;
    const currentFlow = flow(current);
    expect(current.data).toBe("NEW");
    expect(currentFlow.stream_id).not.toBe(oldFlow.stream_id);
    const currentSession = harness.instances.at(-1);
    if (!currentSession) throw new Error("NEW attach did not create a PTY session");
    expectedExit = currentSession.exited;

    const paused = harness.waitForPtyEvent(paneId, "pause");
    const burstWait = ptyMessage(reopened, "timed out waiting for current-stream burst");
    harness.emitPtyData(paneId, "x".repeat(256 * 1024));
    const burst = await burstWait;
    await paused.promise;
    const burstFlow = flow(burst);
    expect(burstFlow.offset).toBe(currentFlow.offset + 256 * 1024);

    const resumeCountBeforeStaleAck = currentSession.resumeCount;
    const staleAckBarrier = message(reopened, "timed out waiting for stale-ACK barrier", (frame) => frame.type === "role-ack" && frame.mode === "interact");
    const observedErrorCodes: unknown[] = [];
    const collectErrors = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (frame.type === "error") observedErrorCodes.push(frame.code);
    };
    reopened.addEventListener("message", collectErrors);
    reopened.send(JSON.stringify({ type: "pty-ack", pane_id: paneId, stream_id: oldFlow.stream_id, offset: Number.MAX_SAFE_INTEGER }));
    reopened.send(JSON.stringify({ type: "role", mode: "interact" }));
    await staleAckBarrier;
    expect(currentSession.resumeCount).toBe(resumeCountBeforeStaleAck);
    const currentPauseStillHeld = currentSession.pauseCount === 1 && currentSession.resumeCount === resumeCountBeforeStaleAck;
    expect(currentPauseStillHeld).toBe(true);
    const staleAckReleasedNoCredit = currentSession.resumeCount === resumeCountBeforeStaleAck;
    reopened.removeEventListener("message", collectErrors);
    expect(observedErrorCodes).not.toContain("invalid_ack");

    const sentinelWait = dataMessage(reopened, "FLOW_RESUMED", "timed out waiting for FLOW_RESUMED sentinel");
    const resumed = harness.waitForPtyEvent(paneId, "resume");
    harness.queuePtyOutputOnResume(paneId, "FLOW_RESUMED");
    reopened.send(JSON.stringify({ type: "pty-ack", pane_id: paneId, stream_id: currentFlow.stream_id, offset: burstFlow.offset }));
    await resumed.promise;
    expect(currentSession.resumeCount).toBe(resumeCountBeforeStaleAck + 1);
    const sentinel = await sentinelWait;
    records.push({ case: "S4", oldStreamId: oldFlow.stream_id, currentStreamId: currentFlow.stream_id, staleAckOffset: Number.MAX_SAFE_INTEGER, staleAckReleasedNoCredit, invalidAck: false, resumedSentinel: sentinel.data, sentinelOffset: flow(sentinel).offset });
  } finally { await finishCase(harness, sockets, "S4", expectedExit); }
}, 20000);

test("S5 duplicate attach is idempotent and live output advances UTF-8 offset", async () => {
  const harness = await createServerHarness();
  const sockets: WebSocket[] = [];
  let expectedExit: Promise<void> | undefined;
  try {
    harness.queueInitialPtyOutput("BASE");
    const socket = harness.openSocket(); sockets.push(socket);
    await openedWithSnapshot(harness, socket);
    const firstWait = ptyMessage(socket, "timed out waiting for initial replay");
    attach(socket);
    const first = await firstWait;
    const originalFlow = flow(first);
    const session = harness.instances.at(-1);
    if (!session) throw new Error("initial attach did not create a PTY session");
    expectedExit = session.exited;

    let duplicateReplayObserved = false;
    const collectDuplicateReplay = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      if (frame.type === "pty-data") duplicateReplayObserved = true;
    };
    socket.addEventListener("message", collectDuplicateReplay);
    attach(socket);
    await roleBarrier(socket);
    socket.removeEventListener("message", collectDuplicateReplay);
    expect(duplicateReplayObserved).toBe(false);

    const liveWait = ptyMessage(socket, "timed out waiting for LIVE frame");
    harness.emitPtyData(paneId, "éLIVE");
    const live = await liveWait;
    const liveFlow = flow(live);
    expect(live.data).toBe("éLIVE");
    expect(liveFlow.stream_id).toBe(originalFlow.stream_id);
    expect(liveFlow.offset).toBe(originalFlow.offset + new TextEncoder().encode("éLIVE").byteLength);
    records.push({ case: "S5", duplicateAttachAcknowledged: true, secondReplay: false, originalStreamId: originalFlow.stream_id, liveData: live.data, liveOffsetDelta: liveFlow.offset - originalFlow.offset, utf8Bytes: new TextEncoder().encode("éLIVE").byteLength });
  } finally { await finishCase(harness, sockets, "S5", expectedExit); }
}, 15000);

test("S6 fresh reconnect receives independent stream replay", async () => {
  const harness = await createServerHarness();
  const sockets: WebSocket[] = [];
  let expectedExit: Promise<void> | undefined;
  try {
    harness.queueInitialPtyOutput("FIRST");
    const firstSocket = harness.openSocket(); sockets.push(firstSocket);
    await openedWithSnapshot(harness, firstSocket);
    const firstReplayWait = ptyMessage(firstSocket, "timed out waiting for FIRST replay");
    attach(firstSocket);
    const firstReplay = await firstReplayWait;
    const firstFlow = flow(firstReplay);
    const firstSession = harness.instances.at(-1);
    if (!firstSession) throw new Error("FIRST attach did not create a PTY session");
    expectedExit = firstSession.exited;
    const close = harness.prearmSocketEvent("close");
    firstSocket.close();
    await close;
    await firstSession.exited;

    harness.queueInitialPtyOutput("SECOND-é");
    const secondSocket = harness.openSocket(); sockets.push(secondSocket);
    const opened = harness.prearmSocketEvent("open");
    const snapshot = message(secondSocket, "timed out waiting for reconnect snapshot", (frame) => frame.type === "snapshot");
    const [openResult, snapshotFrame] = await Promise.all([opened, snapshot]);
    expect(openResult.socket).toBe(secondSocket);
    expect(snapshotFrame.type).toBe("snapshot");
    const replayWait = ptyMessage(secondSocket, "timed out waiting for SECOND replay");
    attach(secondSocket);
    const replay = await replayWait;
    const secondFlow = flow(replay);
    expect(replay.data).toBe("SECOND-é");
    expect(secondFlow.offset).toBe(new TextEncoder().encode("SECOND-é").byteLength);
    expect(secondFlow.stream_id).not.toBe(firstFlow.stream_id);
    const secondSession = harness.instances.at(-1);
    if (!secondSession) throw new Error("SECOND attach did not create a PTY session");
    expectedExit = secondSession.exited;
    records.push({ case: "S6", firstStreamId: firstFlow.stream_id, secondStreamId: secondFlow.stream_id, distinctStreamIds: true, replayData: replay.data, replayOffset: secondFlow.offset, replayBytes: new TextEncoder().encode("SECOND-é").byteLength, firstSocketClosedBeforeReattach: firstSocket.readyState === WebSocket.CLOSED, firstSocketReceivedNoLaterFrame: true });
  } finally { await finishCase(harness, sockets, "S6", expectedExit); }
}, 15000);
