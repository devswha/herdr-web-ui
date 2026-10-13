import { authenticatedWebSocket } from "./remote-websocket.ts";
import type { ServerWebSocket } from "bun";
import { OUTPUT_HARD_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { MachineManager } from "./machines.ts";

/**
 * When a relayed connection counts as stalled: its transport queues have held bytes for longer
 * than OUTPUT_STALL_MS with no progress. Progress is bytes leaving a queue since the last tick, or
 * a browser `pty-ack` whose offset moved. A phone draining a large replay over a weak link keeps
 * making it; the remote PC's own OutputWindow keeps the ACK window and the join budget, so the
 * relay only watches ACKs and never acknowledges anything itself.
 */
export class RelayStall {
  /** since when the queues have held bytes without progress; undefined while they are empty */
  private since: number | undefined;
  private last = 0;
  private queued = 0;
  /** each pane's latest ACK: a duplicate or stale one is no progress */
  private readonly acked = new Map<string, { stream: string; offset: number }>();

  /** bytes just handed to either transport queue */
  queue(bytes: number): void {
    this.queued += bytes;
  }

  ack(pane: string, stream: string, offset: number, now = Date.now()): void {
    const previous = this.acked.get(pane);
    if (previous && previous.stream === stream && offset <= previous.offset) return;
    this.acked.set(pane, { stream, offset });
    if (this.since !== undefined) this.since = now;
  }

  /** `buffered` is what both queues hold now; true once the connection has stalled */
  tick(buffered: number, now = Date.now()): boolean {
    const drained = this.last + this.queued > buffered;
    this.last = buffered;
    this.queued = 0;
    if (!buffered) {
      this.since = undefined;
      return false;
    }
    if (this.since === undefined || drained) this.since = now;
    return now - this.since > OUTPUT_STALL_MS;
  }
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
  private readonly stall = new RelayStall();
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
    this.upstream.onclose = (event) => this.close(event.code === OUTPUT_STALLED_CLOSE_CODE ? event.code : 1012, event.reason || "Remote connection ended");
    this.timer = setInterval(() => {
      const toClient = this.client?.getBufferedAmount() ?? 0;
      const toUpstream = this.upstream.bufferedAmount;
      const stalled = this.stall.tick(toClient + toUpstream);
      if (Math.max(toClient, toUpstream) > OUTPUT_HARD_BYTES || stalled) this.close(OUTPUT_STALLED_CLOSE_CODE, "terminal transport stalled");
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
    const bytes = Buffer.byteLength(raw);
    if (this.client.getBufferedAmount() + bytes > OUTPUT_HARD_BYTES) { this.close(OUTPUT_STALLED_CLOSE_CODE, "output overflow"); return; }
    this.stall.queue(bytes);
    if (this.client.send(raw) === 0) this.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
  }
  message(raw: string | Buffer): void {
    if (this.closed) return;
    if (this.upstream.readyState !== WebSocket.OPEN) { this.close(); return; }
    let text = String(raw);
    const ack = text.includes('"pty-ack"');
    if (this.readOnly || ack) {
      try {
        const message = JSON.parse(text);
        if (this.readOnly && message?.type === "role") text = JSON.stringify({ type: "role", mode: "observe" });
        if (message?.type === "pty-ack" && typeof message.pane_id === "string" && typeof message.stream_id === "string" && Number.isSafeInteger(message.offset)) {
          this.stall.ack(message.pane_id, message.stream_id, message.offset);
        }
      } catch { /* malformed frames are answered by the upstream server */ }
    }
    const bytes = Buffer.byteLength(text);
    if (this.upstream.bufferedAmount + bytes > OUTPUT_HARD_BYTES) { this.close(OUTPUT_STALLED_CLOSE_CODE, "input overflow"); return; }
    this.stall.queue(bytes);
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
