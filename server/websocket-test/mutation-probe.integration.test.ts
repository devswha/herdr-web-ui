import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { createServerHarness, evidenceDirectory } from "./create-server-harness.ts";
import { OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES } from "../output-window.ts";

const caseName = process.env.SODAM_WS_MUTATION_CASE;
const probes = {
  "utf8-byte-count": { scenario: "S1", marker: "MUTATION_ASSERTION_S1_UTF8_BYTE_COUNT" },
  "cumulative-ack": { scenario: "S2", marker: "MUTATION_ASSERTION_S2_CUMULATIVE_ACK" },
  "stale-stream-id": { scenario: "S4", marker: "MUTATION_ASSERTION_S4_STALE_STREAM_ID" },
  "pause-resume": { scenario: "S7", marker: "MUTATION_ASSERTION_S7_PAUSE_RESUME" },
} as const;
type ProbeName = keyof typeof probes;

interface Frame { readonly type: string; readonly [key: string]: unknown }

function requireCase(value: string | undefined): ProbeName {
  if (value === "utf8-byte-count" || value === "cumulative-ack" || value === "stale-stream-id" || value === "pause-resume") return value;
  throw new Error(`unknown or missing SODAM_WS_MUTATION_CASE: ${String(value)}`);
}

function message(socket: WebSocket, predicate: (frame: Frame) => boolean, diagnostic: string): Promise<Frame> {
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
        const value: unknown = JSON.parse(String(event.data));
        if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") throw new Error("invalid WebSocket frame");
        const frame = value as Frame;
        if (!predicate(frame)) return;
        cleanup();
        resolvePromise(frame);
      } catch (error) { cleanup(); rejectPromise(error); }
    };
    const onClose = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket closed`)); };
    const onError = () => { cleanup(); rejectPromise(new Error(`${diagnostic}: socket errored`)); };
    timer = setTimeout(() => { cleanup(); rejectPromise(new Error(diagnostic)); }, 5000);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function flow(frame: Frame): { stream_id: string; offset: number } {
  const value: unknown = frame["flow"];
  if (typeof value !== "object" || value === null || !("stream_id" in value) || !("offset" in value)) throw new Error("pty-data omitted flow metadata");
  return { stream_id: String(value.stream_id), offset: Number(value.offset) };
}

function marker(name: ProbeName, detail: string): never {
  throw new Error(`${probes[name].marker}: ${detail}`);
}

async function c0(
  harness: Awaited<ReturnType<typeof createServerHarness>>,
  sockets: WebSocket[],
  name: ProbeName,
  outcome: Record<string, unknown>,
): Promise<void> {
  const stateDir = harness.stateDir;
  const instances = [...harness.instances];
  let cleanupResult: Awaited<ReturnType<typeof harness.cleanup>> | undefined;
  let cleanupError: unknown;
  try { cleanupResult = await harness.cleanup(); }
  catch (error) { cleanupError = error; }
  const socketsClosed = sockets.every((socket) => socket.readyState === WebSocket.CLOSED);
  const fakeExitedResolved = instances.length > 0 && instances.every((instance) => instance.killCount === 1);
  const stateDirAbsent = await access(stateDir).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  const stoppedPortHandshakeFailed = await new Promise<boolean>((resolvePromise) => {
    const stopped = new WebSocket(`${harness.baseUrl}/ws`);
    const timer = setTimeout(() => { stopped.close(); resolvePromise(false); }, 5000);
    const onError = () => { clearTimeout(timer); stopped.removeEventListener("open", onOpen); resolvePromise(true); };
    const onOpen = () => { clearTimeout(timer); stopped.removeEventListener("error", onError); stopped.close(); resolvePromise(false); };
    stopped.addEventListener("error", onError, { once: true });
    stopped.addEventListener("open", onOpen, { once: true });
  });
  const receipt = {
    scenario: probes[name].scenario,
    socketsOpened: sockets.length,
    socketsClosed: socketsClosed ? sockets.length : 0,
    fakeExitedResolved,
    subscriptionCloseDelta: cleanupResult?.subscriptionCloseDelta ?? 0,
    subscriptionsClosed: (cleanupResult?.subscriptionCloseDelta ?? 0) > 0,
    stateDirAbsent,
    stoppedPortHandshakeFailed,
    cleanupError: cleanupError === undefined ? null : String(cleanupError),
  };
  if (cleanupError !== undefined) throw cleanupError;
  expect(receipt.socketsClosed).toBe(sockets.length);
  expect(receipt.fakeExitedResolved).toBe(true);
  expect(receipt.subscriptionsClosed).toBe(true);
  expect(receipt.stateDirAbsent).toBe(true);
  expect(receipt.stoppedPortHandshakeFailed).toBe(true);
  const directory = evidenceDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "scenario.jsonl"), `${JSON.stringify({ ...outcome, scenario: probes[name].scenario })}\n`, "utf8");
  await writeFile(resolve(directory, "scenario-cleanup.json"), `${JSON.stringify({ cases: [receipt] }, null, 2)}\n`, "utf8");
}

async function runProbe(name: ProbeName): Promise<void> {
  const harness = await createServerHarness();
  const sockets: WebSocket[] = [];
  let outcome: Record<string, unknown> = { passed: false };
  let assertionError: unknown;
  try {
    if (name === "utf8-byte-count") harness.queueInitialPtyOutput("\u001b[?1000h", "\u001b[?1006h", "éREPLAY");
    else harness.queueInitialPtyOutput("BASE");
    const socket = harness.openSocket(); sockets.push(socket);
    await Promise.all([
      harness.prearmSocketEvent("open"),
      message(socket, (frame) => frame.type === "snapshot", "snapshot timeout"),
    ]);
    let current: { stream_id: string; offset: number };
    let firstData: Frame | undefined;
    if (name === "pause-resume") {
      const readyMessage = message(socket, (frame) => frame.type === "pane-geometry" || frame.type === "pty-data", "S7 attach timeout");
      const initialWait = message(socket, (frame) => frame.type === "pty-data", "S7 initial data timeout");
      socket.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 100, rows: 30, flow_control: "ack" }));
      const [initial, initialData] = await Promise.all([readyMessage, initialWait]);
      const initialFrame = initial.type === "pty-data" ? initial : initialData;
      current = flow(initialFrame);
    } else {
      const attachReply = message(socket, (frame) => frame.type === "pane-geometry" || frame.type === "pty-data", "attach reply timeout");
      socket.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 100, rows: 30, flow_control: "ack" }));
      const first = await attachReply;
      const currentFrame = first.type === "pty-data" ? first : await message(socket, (frame) => frame.type === "pty-data", "initial data timeout");
      firstData = currentFrame;
      current = flow(currentFrame);
    }
    const ptySession = harness.instances.at(-1);
    if (!ptySession) throw new Error("attach did not create a fake PTY session");

    if (name === "utf8-byte-count") {
      const replay = firstData;
      if (!replay) throw new Error("initial replay was missing");
      const replayFlow = flow(replay);
      const replayExpected = Buffer.byteLength(String(replay["data"]), "utf8");
      if (replayFlow.offset !== replayExpected) marker(name, `replay offset ${replayFlow.offset} != UTF-8 byteLength offset ${replayExpected}`);
      current = replayFlow;
      const liveWait = message(socket, (frame) => frame.type === "pty-data", "live data timeout");
      harness.emitPtyData(harness.paneId, "éLIVE");
      const live = await liveWait;
      const liveFlow = flow(live);
      const expected = current.offset + Buffer.byteLength(String(live["data"]), "utf8");
      if (liveFlow.offset !== expected) marker(name, `live offset ${liveFlow.offset} != UTF-8 byteLength offset ${expected}`);
      outcome = { passed: true, replayData: replay["data"], replayOffset: replayFlow.offset, replayExpected, data: live["data"], offset: liveFlow.offset, expected };
    } else if (name === "cumulative-ack") {
      const pauseWait = harness.waitForPtyEvent(harness.paneId, "pause");
      const burstWait = message(socket, (frame) => frame.type === "pty-data", "A burst timeout");
      harness.emitPtyData(harness.paneId, "A".repeat(300000));
      const firstBurst = await burstWait; await pauseWait.promise;
      current = flow(firstBurst);
      const resumeWait = harness.waitForPtyEvent(harness.paneId, "resume");
      socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: current.stream_id, offset: current.offset }));
      await resumeWait.promise;
      const roleAck = message(socket, (frame) => frame.type === "role-ack" && frame.mode === "observe", "role-ack barrier timeout");
      socket.send(JSON.stringify({ type: "role", mode: "observe" }));
      await roleAck;
      const regressiveAckBarrier = message(socket, (frame) => frame.type === "role-ack" && frame.mode === "observe", "regressive ACK barrier timeout");
      const secondWait = message(socket, (frame) => frame.type === "pty-data", "B burst timeout");
      socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: current.stream_id, offset: 100000 }));
      socket.send(JSON.stringify({ type: "role", mode: "observe" }));
      await regressiveAckBarrier;
      harness.emitPtyData(harness.paneId, "B".repeat(63000));
      const second = await secondWait.catch((error) => {
        if (error instanceof Error && error.message.includes("timeout")) marker(name, `regressive ACK blocked the expected B frame: ${error.message}`);
        throw error;
      });
      if (second.type !== "pty-data" || ptySession.pauseCount !== 1) marker(name, `regressive ACK restored credit: pauseCount=${ptySession.pauseCount}, B offset=${flow(second).offset}`);
      outcome = { passed: true, firstOffset: current.offset, secondOffset: flow(second).offset, pauseCount: ptySession.pauseCount };
    } else if (name === "stale-stream-id") {
      const oldStream = current.stream_id;
      const initialClosed = message(socket, () => false, "initial websocket close timeout");
      socket.close();
      await initialClosed.catch((error) => {
        if (!(error instanceof Error) || !error.message.includes("socket closed")) throw error;
      });
      harness.queueInitialPtyOutput("NEW");
      const reopened = harness.openSocket(); sockets.push(reopened);
      await Promise.all([
        harness.prearmSocketEvent("open"),
        message(reopened, (frame) => frame.type === "snapshot", "reconnect snapshot timeout"),
      ]);
      const replayWait = message(reopened, (frame) => frame.type === "pty-data", "new replay timeout");
      reopened.send(JSON.stringify({ type: "attach", pane_id: harness.paneId, cols: 100, rows: 30, flow_control: "ack" }));
      const replay = await replayWait;
      current = flow(replay);
      const pauseWait = harness.waitForPtyEvent(harness.paneId, "pause");
      const burstWait = message(reopened, (frame) => frame.type === "pty-data", "current burst timeout");
      harness.emitPtyData(harness.paneId, "x".repeat(256 * 1024));
      const currentBurst = await burstWait;
      await pauseWait.promise;
      const currentPty = harness.instances.at(-1);
      if (!currentPty) throw new Error("reconnected attach did not create a fake PTY session");
      const resumeCount = currentPty.resumeCount;
      const barrier = message(reopened, (frame) => frame.type === "role-ack" && frame.mode === "observe", "stale ACK ordering barrier timeout");
      const errorCodes: string[] = [];
      const collect = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === "error") errorCodes.push(String(frame.code));
      };
      reopened.addEventListener("message", collect);
      reopened.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: oldStream, offset: Number.MAX_SAFE_INTEGER }));
      reopened.send(JSON.stringify({ type: "role", mode: "observe" }));
      await barrier;
      reopened.removeEventListener("message", collect);
      const currentPauseHeld = currentPty.resumeCount === resumeCount && currentPty.pauseCount === 1 && !errorCodes.includes("invalid_ack");
      if (!currentPauseHeld) marker(name, `old stream ACK affected current credit: errors=${errorCodes.join(",")}, resumeCount=${currentPty.resumeCount}`);
      harness.queuePtyOutputOnResume(harness.paneId, "FLOW_RESUMED");
      const validResume = message(reopened, (frame) => frame.type === "pty-data" && frame.data === "FLOW_RESUMED", "valid current stream did not resume");
      const resumeEvent = harness.waitForPtyEvent(harness.paneId, "resume");
      reopened.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: current.stream_id, offset: flow(currentBurst).offset }));
      await resumeEvent.promise;
      const sentinel = await validResume;
      outcome = { passed: true, oldStream, currentStream: current.stream_id, currentPauseHeld, errors: errorCodes, sentinel: sentinel["data"] };
    } else {
      const highWait = message(socket, (frame) => frame.type === "pty-data", "high output timeout");
      const pause = harness.waitForPtyEvent(harness.paneId, "pause");
      harness.emitPtyData(harness.paneId, "H".repeat(OUTPUT_HIGH_BYTES));
      const high = await highWait; await pause.promise;
      const highFlow = flow(high);
      const before = ptySession.resumeCount;
      const resume = harness.waitForPtyEvent(harness.paneId, "resume");
      const sentinel = message(socket, (frame) => frame.type === "pty-data" && frame.data === "FLOW_RESUMED", "resume sentinel missing");
      void sentinel.catch(() => undefined);
      harness.queuePtyOutputOnResume(harness.paneId, "FLOW_RESUMED");
      socket.send(JSON.stringify({ type: "pty-ack", pane_id: harness.paneId, stream_id: highFlow.stream_id, offset: highFlow.offset - OUTPUT_LOW_BYTES }));
      try {
        await resume.promise;
      } catch (error) {
        if (ptySession.resumeCount === before) marker(name, `resume event missing after low-water ACK: ${String(error)}`);
        throw error;
      }
      const resumed = await sentinel;
      if (ptySession.resumeCount !== before + 1 || !String(resumed["data"]).includes("FLOW_RESUMED")) marker(name, `resume count/sentinel mismatch after barrier: ${ptySession.resumeCount - before}`);
      outcome = { passed: true, initialOffset: current.offset, resumeDelta: ptySession.resumeCount - before, sentinel: resumed["data"] };
    }
  } catch (error) {
    assertionError = error;
    if (error instanceof Error && error.message.includes(probes[name].marker)) outcome = { ...outcome, marker: probes[name].marker, detail: error.message };
  }

  try { await c0(harness, sockets, name, outcome); }
  catch (error) {
    if (assertionError === undefined) assertionError = error;
    else if (error instanceof Error) assertionError = new AggregateError([assertionError, error], "probe assertion and C0 cleanup failed");
  }
  if (assertionError !== undefined) throw assertionError;
  expect(outcome["passed"]).toBe(true);
}

const selected = requireCase(caseName);
test(`targeted websocket mutation probe: ${selected}`, () => runProbe(selected), 20000);
