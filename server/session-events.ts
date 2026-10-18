import type { SessionEvent, HerdrPane, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import type { PreferenceStore } from "./preferences.ts";

/** One workstation's live roster, shared by authenticated browsers, including read-only devices. */
export class SessionEvents {
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly connections = new Set<() => void>();
  private readonly heardAgents = new Map<string, string | null>();
  private snapshot: SessionSnapshot | null = null;
  private revision = 0;
  private busy = false;
  private queued = false;
  private stopped = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly read: () => Promise<SessionSnapshot>, private readonly preferences: PreferenceStore, private readonly herdrSidebar?: HerdrSidebarConfig) {
    this.timer = setInterval(() => void this.refresh(), 5000);
    this.timer.unref();
    void this.refresh();
  }

  agents(panes: readonly Pick<HerdrPane, "pane_id" | "agent">[]): void {
    let changed = false;
    for (const pane of panes) {
      const before = this.heardAgents.get(pane.pane_id);
      const agent = pane.agent ?? null;
      this.heardAgents.set(pane.pane_id, agent);
      if (before !== agent && !(before === undefined && agent === null)) changed = true;
    }
    if (changed) void this.refresh();
  }

  message(message: ServerMessage): void {
    // A status received during a read outranks that older snapshot. Structural events only
    // queue another read, so continuous layout changes cannot starve roster publication.
    if (message.type === "pane-status" || message.type === "pane-exited") {
      this.revision++;
      if (this.busy) this.queued = true;
      this.snapshot = null;
    }
    this.emit({ type: "message", message });
    if (message.type === "pane-exited") this.heardAgents.delete(message.pane_id);
    if (message.type === "session-changed" || message.type === "pane-exited") void this.refresh();
  }

  private emit(event: SessionEvent): void {
    if (!this.stopped) for (const listener of this.listeners) listener(event);
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.busy) { this.queued = true; return; }
    this.busy = true;
    try {
      do {
        this.queued = false;
        const revision = this.revision;
        try {
          const snapshot = await this.read();
          if (this.stopped) return;
          if (revision !== this.revision) { this.queued = true; continue; }
          this.snapshot = snapshot;
          const open = new Set(snapshot.panes.map((pane) => pane.pane_id));
          for (const id of this.heardAgents.keys()) if (!open.has(id)) this.heardAgents.delete(id);
          this.emit({ type: "snapshot", snapshot });
        } catch {
          // Do not give a newly connected browser a cached healthy roster after a failed read.
          this.snapshot = null;
          // HTTP polling reports the failure; keep the stream open for recovery.
        }
      } while (this.queued && !this.stopped);
    } finally { this.busy = false; }
  }

  response(request: Request, onRevoke?: (close: () => void) => () => void): Response {
    let close = () => {};
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        let stopPreferences: (() => void) | undefined;
        let stopSidebar: (() => void) | undefined;
        let unwatchDevice: (() => void) | undefined;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const send = (text: string) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) < -4) { close(); return; }
          try { controller.enqueue(encoder.encode(text)); } catch { close(); }
        };
        const listener = (event: SessionEvent) => send(`data: ${JSON.stringify(event)}\n\n`);
        close = () => {
          if (closed) return;
          closed = true;
          this.listeners.delete(listener);
          this.connections.delete(close);
          stopPreferences?.(); stopSidebar?.(); unwatchDevice?.(); clearInterval(heartbeat);
          request.signal.removeEventListener("abort", close);
          try { controller.close(); } catch { /* already cancelled */ }
        };
        this.connections.add(close);
        unwatchDevice = onRevoke?.(close);
        if (closed) { unwatchDevice?.(); return; }
        this.listeners.add(listener);
        stopPreferences = this.preferences.subscribe((preferences) => listener({ type: "preferences", preferences }));
        listener({ type: "preferences", preferences: this.preferences.get() });
        // Read before listening: existing browsers hear a change found here, this one hears it once.
        if (this.herdrSidebar) listener({ type: "herdr-sidebar", agents: this.herdrSidebar.get() });
        stopSidebar = this.herdrSidebar?.subscribe((agents) => listener({ type: "herdr-sidebar", agents }));
        if (this.snapshot) listener({ type: "snapshot", snapshot: this.snapshot });
        else void this.refresh();
        if (closed) return;
        heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
      },
      cancel() { close(); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const close of this.connections) close();
    this.listeners.clear();
  }
}
