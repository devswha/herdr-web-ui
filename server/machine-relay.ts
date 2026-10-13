import { authenticatedWebSocket } from "./remote-websocket.ts";
import type { ServerWebSocket } from "bun";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { MachineManager } from "./machines.ts";

/** The relay's own transport stalled: the phone reconnects and re-attaches instead of stopping for good. */
export const RELAY_STALL_CLOSE_CODE = 1012;

/**
 * The relay's backstop against its own sockets backing up. It uses the local bridge's
 * hysteresis (blocked from OUTPUT_HIGH_BYTES until OUTPUT_LOW_BYTES), because a slow phone
 * link keeps a few KB queued in userspace while output still moves; the end-to-end ACK window
 * is enforced by the remote bridge. Returns the close code to use, or 0 to keep going.
 */
export class RelayStallClock {
  private blockedAt: number | null = null;

  sample(buffered: number, now: number): number {
    if (buffered > OUTPUT_HARD_BYTES) return OUTPUT_STALLED_CLOSE_CODE;
    if (buffered <= OUTPUT_LOW_BYTES) this.blockedAt = null;
    else if (buffered >= OUTPUT_HIGH_BYTES && this.blockedAt === null) this.blockedAt = now;
    return this.blockedAt !== null && now - this.blockedAt >= OUTPUT_STALL_MS ? RELAY_STALL_CLOSE_CODE : 0;
  }
}

/** The phone sees an upstream 4008 as is (the remote bridge's ACK window stalled); any other end is 1012. */
export function upstreamCloseCode(code: number): number {
  return code === OUTPUT_STALLED_CLOSE_CODE ? code : 1012;
}

/** Relay ACK frames unchanged: only xterm parsing releases remote output credit. */
export class MachineRelay {
  private upstream: WebSocket;
  private client?: ServerWebSocket<unknown>;
  private waiting: string[] = [];
  private bytes = 0;
  private closed = false;
  private untrack: () => void;
  private timer: ReturnType<typeof setInterval>;
  private stall = new RelayStallClock();
  readonly ready: Promise<void>;

  constructor(manager: MachineManager, id: string, private readonly readOnly = false) {
    const endpoint = manager.endpoint(id);
    if (!endpoint) throw new Error("This PC is disconnected");
    this.upstream = authenticatedWebSocket(endpoint.url.replace("http:", "ws:") + "/ws", endpoint.token);
    this.untrack = manager.trackTerminal(id, () => this.close(1012, "PC disconnected"));
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.close(); reject(new Error("Remote websocket timed out")); }, 15_000);
      this.upstream.addEventListener("open", () => {
        if (this.readOnly) this.upstream.send(JSON.stringify({ type: "role", mode: "observe" }));
        clearTimeout(timeout); resolve();
      }, { once: true });
      this.upstream.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Remote websocket unavailable")); this.close(); }, { once: true });
      this.upstream.addEventListener("close", () => { clearTimeout(timeout); reject(new Error("Remote websocket closed")); }, { once: true });
    });
    this.upstream.onmessage = (event) => {
      const raw = String(event.data);
      if (this.closed) return;
      if (!this.client) {
        this.bytes += Buffer.byteLength(raw);
        if (this.bytes > OUTPUT_HARD_BYTES) this.close(OUTPUT_STALLED_CLOSE_CODE, "output overflow");
        else this.waiting.push(raw);
      } else this.send(raw);
    };
    this.upstream.onclose = (event) => this.close(upstreamCloseCode(event.code), event.reason || "Remote connection ended");
    this.timer = setInterval(() => {
      const buffered = Math.max(this.client?.getBufferedAmount() ?? 0, this.upstream.bufferedAmount);
      const code = this.stall.sample(buffered, Date.now());
      if (code) this.close(code, code === OUTPUT_STALLED_CLOSE_CODE ? "output overflow" : "relay transport stalled");
    }, 100);
    this.timer.unref();
  }
  bind(client: ServerWebSocket<unknown>): void {
    this.client = client;
    if (this.closed) { client.close(1012, "Remote connection ended"); return; }
    for (const raw of this.waiting) this.send(raw);
    this.waiting = []; this.bytes = 0;
  }
  private send(raw: string): void {
    if (this.closed || !this.client) return;
    if (this.client.getBufferedAmount() + Buffer.byteLength(raw) > OUTPUT_HARD_BYTES) { this.close(OUTPUT_STALLED_CLOSE_CODE, "output overflow"); return; }
    if (this.client.send(raw) === 0) this.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
  }
  message(raw: string | Buffer): void {
    if (this.closed) return;
    if (this.upstream.readyState !== WebSocket.OPEN) { this.close(); return; }
    let text = String(raw);
    if (this.readOnly) {
      try {
        const message = JSON.parse(text);
        if (message?.type === "role") text = JSON.stringify({ type: "role", mode: "observe" });
      } catch { /* malformed frames are answered by the upstream server */ }
    }
    if (this.upstream.bufferedAmount + Buffer.byteLength(text) > OUTPUT_HARD_BYTES) { this.close(OUTPUT_STALLED_CLOSE_CODE, "input overflow"); return; }
    this.upstream.send(text);
  }
  close(code = 1000, reason = "Closed"): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.untrack();
    this.waiting = []; this.bytes = 0;
    const boundedReason = Buffer.from(reason).subarray(0, 100).toString("utf8");
    this.upstream.close(code, boundedReason); this.client?.close(code, boundedReason);
  }
}
