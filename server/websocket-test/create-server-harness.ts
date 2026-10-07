import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "bun:test";
import { FakePtySession, onPtyEvent, queueInitialOutput, type PtyEvent, type PtyEventType } from "./fake-pty-session.ts";
import * as fakeHerdrClient from "./fake-herdr-client.ts";

const checkoutRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const websocketRunRoot = resolve(process.env.SODAM_WS_RUN_ROOT ?? join(tmpdir(), `herdr-websocket-${crypto.randomUUID()}`));
const originalIndex = resolve(checkoutRoot, "server/index.ts");
const clientPath = resolve(checkoutRoot, "server/herdr/client.ts");
const ptyPath = resolve(checkoutRoot, "server/pty/session.ts");
const fakePane = "fake-pane";
const timeoutMs = 5000;

export function resolveContainedPath(value: string, fallback: string): string {
  const candidate = resolve(value || fallback);
  const rel = relative(websocketRunRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`path must resolve under ${websocketRunRoot}: ${candidate}`);
  }
  return candidate;
}

export function defaultServerIndex(): string {
  const override = process.env.SODAM_WS_SERVER_INDEX;
  return override === undefined ? originalIndex : resolveContainedPath(override, originalIndex);
}

export function evidenceDirectory(): string {
  return resolveContainedPath(process.env.SODAM_WS_EVIDENCE_DIR ?? join(websocketRunRoot, "evidence"), join(websocketRunRoot, "evidence"));
}

export interface PtyEventWaiter {
  readonly promise: Promise<PtyEvent>;
  readonly cancel: () => void;
}

export function prearmPtyEvent(type: PtyEventType, timeout = timeoutMs): PtyEventWaiter {
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const promise = new Promise<PtyEvent>((resolvePromise, rejectPromise) => {
    unsubscribe = onPtyEvent((event) => {
      if (event.type !== type) return;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolvePromise(event);
    });
    timer = setTimeout(() => {
      unsubscribe();
      rejectPromise(new Error(`timed out waiting for PTY ${type}`));
    }, timeout);
    cancel = () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  });
  return { promise, cancel };
}

export async function createServerHarness(): Promise<{
  readonly serverIndex: string;
  readonly baseUrl: string;
  readonly stateDir: string;
  readonly paneId: string;
  readonly instances: FakePtySession[];
  readonly openSocket: () => WebSocket;
  readonly connect: () => Promise<WebSocket>;
  readonly prearmSocketEvent: (type: "open" | "close" | "error", timeout?: number) => Promise<{ socket: WebSocket; event: Event }>;
  readonly waitForPtyEvent: (paneId: string, type: PtyEventType) => PtyEventWaiter;
  readonly queueInitialPtyOutput: (...chunks: string[]) => void;
  readonly emitPtyData: (paneId: string, data: string) => void;
  readonly queuePtyOutputOnResume: (paneId: string, data: string) => void;
  readonly cleanup: () => Promise<{ readonly subscriptionCloseDelta: number }>;
}> {
  const serverIndex = defaultServerIndex();
  const evidenceDir = evidenceDirectory();
  await mkdir(evidenceDir, { recursive: true });
  const stateDir = resolve(websocketRunRoot, `state-${crypto.randomUUID()}`);
  await mkdir(stateDir, { recursive: true });
  const priorSocket = process.env.HERDR_SOCKET;
  const socketPath = resolve(websocketRunRoot, `missing-herdr-${crypto.randomUUID()}.sock`);
  const restoreSocket = () => {
    if (priorSocket === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = priorSocket;
  };
  process.env.HERDR_SOCKET = socketPath;
  const instances: FakePtySession[] = [];
  let server: { port: number; hostname: string; stop: () => void } | undefined;
  try {
    mock.module(clientPath, () => ({
      ...fakeHerdrClient,
      herdrRpc: fakeHerdrClient.unexpectedRpc,
    }));
    mock.module(ptyPath, () => ({
      PtySession: class extends FakePtySession {
        constructor(options: ConstructorParameters<typeof FakePtySession>[0]) {
          const mapped = { ...options, onExit: (code: number | null) => options.onExit(code) };
          super(mapped);
          instances.push(this);
        }
      },
    }));
    const imported = await import(serverIndex);
    server = imported.createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, machines: false, registerBridge: false });
  } catch (error) {
    server?.stop();
    for (const instance of instances) instance.kill();
    await Promise.all(instances.map((instance) => instance.exited));
    await rm(stateDir, { recursive: true, force: true });
    restoreSocket();
    throw error;
  }
  if (server === undefined) throw new Error("createServer did not return a running server");
  const runningServer = server;

  const sockets = new Set<WebSocket>();
  const closeWaiters = new Map<WebSocket, Promise<Event>>();
  const ptyWaiters = new Set<PtyEventWaiter>();
  const prearmSocketEvent = (type: "open" | "close" | "error", timeout = timeoutMs) => {
    const socket = [...sockets].at(-1);
    if (!socket) throw new Error("connect a socket before pre-arming its event");
    let timer: ReturnType<typeof setTimeout>;
    const eventPromise = new Promise<Event>((resolvePromise, rejectPromise) => {
      socket.addEventListener(type, (event) => { clearTimeout(timer); resolvePromise(event); }, { once: true });
      timer = setTimeout(() => rejectPromise(new Error(`timed out waiting for socket ${type}`)), timeout);
    });
    const result = eventPromise.then((event) => ({ socket, event }));
    if (type === "close") closeWaiters.set(socket, eventPromise);
    return result;
  };
  const openSocket = (): WebSocket => {
    const opening = new WebSocket(`ws://${runningServer.hostname}:${runningServer.port}/ws`);
    sockets.add(opening);
    prearmSocketEvent("close");
    return opening;
  };
  const connect = async (): Promise<WebSocket> => {
    const opening = openSocket();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("timed out opening websocket")), timeoutMs);
      opening.addEventListener("open", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      opening.addEventListener("error", () => { clearTimeout(timer); rejectPromise(new Error("websocket failed to open")); }, { once: true });
    });
    return opening;
  };
  const waitForPtyEvent = (paneId: string, type: PtyEventType): PtyEventWaiter => {
    if (paneId !== fakePane) throw new Error(`unknown fake pane: ${paneId}`);
    const waiter = prearmPtyEvent(type);
    ptyWaiters.add(waiter);
    return waiter;
  };

  return {
    serverIndex, baseUrl: `ws://${runningServer.hostname}:${runningServer.port}`, stateDir, paneId: fakePane, instances, openSocket, connect, prearmSocketEvent, waitForPtyEvent,
    queueInitialPtyOutput: (...chunks) => queueInitialOutput(...chunks),
    emitPtyData: (paneId, data) => { if (paneId !== fakePane) throw new Error(`unknown fake pane: ${paneId}`); instances.at(-1)?.emitData(data); },
    queuePtyOutputOnResume: (paneId, data) => { if (paneId !== fakePane) throw new Error(`unknown fake pane: ${paneId}`); instances.at(-1)?.queueOutputOnResume(data); },
    async cleanup() {
      const before = fakeHerdrClient.getFakeHerdrCounters().subscriptionCloseCount;
      for (const waiter of ptyWaiters) waiter.cancel();
      for (const socket of sockets) socket.close();
      await Promise.all([...closeWaiters.values()]);
      runningServer.stop();
      for (const instance of instances) instance.kill();
      await Promise.all(instances.map((instance) => instance.exited));
      try {
        const subscriptionCloseDelta = fakeHerdrClient.getFakeHerdrCounters().subscriptionCloseCount - before;
        await rm(stateDir, { recursive: true, force: true });
        return { subscriptionCloseDelta };
      } finally {
        restoreSocket();
        sockets.clear(); closeWaiters.clear(); instances.length = 0; ptyWaiters.clear();
      }
    },
  };
}
