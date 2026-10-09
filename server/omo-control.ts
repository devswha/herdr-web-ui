import { closeSync, constants, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { OmoProgress } from "../shared/protocol.ts";
import { object } from "./omo-progress-records.ts";

type Activity = OmoProgress["activity"];
const REQUEST_ID = "herdr-progress";
const RESPONSE_LIMIT = 1024 * 1024;
const CONNECTION_MS = 300;
const DISCOVERY_MS = 5000;

/** Bounded plain-file reads: no FIFO or unbounded credential/registry file. */
function fileBytes(path: string, limit: number): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return null;
    const bytes = Buffer.alloc(stat.size);
    const got = readSync(fd, bytes, 0, bytes.length, 0);
    return got === bytes.length ? bytes : null;
  } catch { return null; } // absent/rotating registry and secret files are expected
  finally { if (fd !== undefined) closeSync(fd); }
}

export function controlActivity(data: unknown): Activity | null {
  if (!object(data) || typeof data.isStreaming !== "boolean" ||
      typeof data.isCompacting !== "boolean" || typeof data.retryAttempt !== "number" ||
      !Number.isSafeInteger(data.retryAttempt) || data.retryAttempt < 0) return null;
  if (data.isCompacting || data.compacting === true) return "compacting";
  if (data.retryAttempt > 0) return "retrying";
  return data.isStreaming ? "working" : "idle";
}

interface State { readonly sessionId: string; readonly activity: Activity }

/** The only command ever sent is get_state; full state and secrets are discarded here. */
export async function readControlState(socketPath: string): Promise<State | null> {
  const secret = fileBytes(`${socketPath}.secret`, 32);
  if (secret?.length !== 32) return null;
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (state: State | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(state);
    };
    // Absolute deadline includes connection and slow/drip-fed responses.
    const timer = setTimeout(() => finish(null), CONNECTION_MS);
    socket.once("connect", () => {
      socket.write(secret);
      socket.write(`${JSON.stringify({ id: REQUEST_ID, type: "get_state" })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      if (bytes.length + chunk.length > RESPONSE_LIMIT) { finish(null); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline === -1) return;
      try {
        const response: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!object(response) || response.id !== REQUEST_ID || response.type !== "response" ||
            response.command !== "get_state" || response.success !== true || !object(response.data) ||
            typeof response.data.sessionId !== "string") { finish(null); return; }
        const activity = controlActivity(response.data);
        finish(activity === null ? null : { sessionId: response.data.sessionId, activity });
      } catch { finish(null); } // protocol boundary: malformed response is not authority
    });
    socket.once("error", () => finish(null));
    socket.once("close", () => finish(null));
  });
}

/** One shared discovery per five seconds, including negative results. Known sessions use
 * only their socket on subsequent polls; mismatches are never reassigned to the requested pane.
 */
export class OmoControl {
  private readonly sockets = new Map<string, string>();
  private discoveredAt = -Infinity;
  private discovery: Promise<Map<string, Activity>> | null = null;

  constructor(
    private readonly agentDir = join(homedir(), ".omo", "agent"),
    private readonly now: () => number = Date.now,
    private readonly query = readControlState,
  ) {}

  async activity(sessionId: string): Promise<Activity | null> {
    const socket = this.sockets.get(sessionId);
    if (socket !== undefined) {
      const state = await this.query(socket);
      if (state?.sessionId === sessionId) return state.activity;
      this.sockets.delete(sessionId);
      return null;
    }
    if (this.discovery !== null) return (await this.discovery).get(sessionId) ?? null;
    if (this.now() - this.discoveredAt < DISCOVERY_MS) return null;
    this.discoveredAt = this.now();
    this.discovery = this.discover().finally(() => { this.discovery = null; });
    return (await this.discovery).get(sessionId) ?? null;
  }

  private async discover(): Promise<Map<string, Activity>> {
    const dir = join(this.agentDir, "rpc-host-daemon");
    let names: string[];
    try { names = readdirSync(dir); } catch { return new Map(); }
    const paths: string[] = [];
    for (const name of names.filter((name) => /^[a-f0-9]{16}$/.test(name)).slice(0, 256)) {
      const bytes = fileBytes(join(dir, name, "endpoint.json"), 16 * 1024);
      if (bytes === null) continue;
      try {
        const endpoint: unknown = JSON.parse(bytes.toString("utf8"));
        if (object(endpoint) && endpoint.endpoint_kind === "tui" &&
            typeof endpoint.socket === "string" && isAbsolute(endpoint.socket)) paths.push(endpoint.socket);
      } catch { continue; }
    }
    // Bound discovery fan-out and total latency; no browser poll scans every endpoint again.
    const states = await Promise.all([...new Set(paths)].slice(0, 32).map(async (path) => ({ path, state: await this.query(path) })));
    const found = new Map<string, Activity>();
    const duplicates = new Set<string>();
    for (const { path, state } of states) {
      if (state === null) continue;
      if (found.has(state.sessionId)) duplicates.add(state.sessionId);
      found.set(state.sessionId, state.activity);
      this.sockets.set(state.sessionId, path);
    }
    for (const id of duplicates) { found.delete(id); this.sockets.delete(id); }
    return found;
  }
}
