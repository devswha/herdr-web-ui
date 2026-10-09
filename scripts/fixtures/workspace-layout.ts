/** Loaded after the demo transport, before the real client. Fictional remote PC, no live sessions. */
import type { Machine, MachineEvent, SessionSnapshot } from "../../shared/protocol.ts";
import panes from "../../site/demo/fixtures/panes.json";

const demoFetch = window.fetch.bind(window);
const demoSocket = window.WebSocket;
const requests: { path: string; method: string }[] = [];
const frames: { machine: string; type: string; pane_id?: string }[] = [];
let remoteState: Machine["state"] = "connected";
const enabled = new URL(location.href).searchParams.has("remote");
const roster = async (): Promise<Machine[]> => {
  const body: { machines: Machine[] } = await (await demoFetch("/api/machines")).json();
  if (!enabled) return body.machines;
  const host = body.machines[0];
  if (!host?.snapshot) throw new Error("Demo host is missing");
  const snapshot = structuredClone(host.snapshot);
  snapshot.panes = snapshot.panes.filter((pane) => pane.pane_id === panes.api).map((pane) => ({ ...pane, label: "Remote duplicate ID", agent_status: "idle" }));
  snapshot.agents = snapshot.agents.filter((agent) => agent.pane_id === panes.api);
  snapshot.workspaces = snapshot.workspaces.filter((workspace) => snapshot.panes.some((pane) => pane.workspace_id === workspace.workspace_id));
  snapshot.tabs = snapshot.tabs.filter((tab) => snapshot.panes.some((pane) => pane.tab_id === tab.tab_id));
  snapshot.layouts = [];
  return [...body.machines, { ...host, id: "qa-remote", kind: "ssh", name: "QA remote", state: remoteState, snapshot }];
};
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  requests.push({ path: url.pathname, method });
  if (url.pathname === "/api/machines") return Response.json({ machines: await roster() });
  if (url.pathname.startsWith("/api/machines/qa-remote/")) {
    const machine = (await roster()).find((entry) => entry.id === "qa-remote");
    if (machine?.state !== "connected") return Response.json({ error: { code: "machine_unavailable", message: "Fixture PC offline" } }, { status: 502 });
    if (url.pathname.endsWith("/session")) return Response.json({ snapshot: machine.snapshot });
    if (url.pathname.endsWith("/pane/conversation")) return Response.json({ source: "claude-transcript", cursor: null, turns: [
      { role: "assistant", ts: null, end_ts: 1, parts: [{ kind: "text", text: "Fictional remote conversation." }] },
    ] });
    if (url.pathname.endsWith("/pane/focus")) return Response.json({ ok: true });
    // Other read-only demo content still comes from the fictional bridge.
    url.pathname = url.pathname.replace("/api/machines/qa-remote/", "/api/");
    return demoFetch(url, init);
  }
  return demoFetch(input, init);
};

class LayoutEvents extends EventTarget {
  readonly url: string;
  readonly readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private closed = false;
  private refresh = () => {
    void roster().then((machines) => {
      if (this.closed) return;
      const event = new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines } satisfies MachineEvent) });
      this.onmessage?.(event); this.dispatchEvent(event);
    });
  };
  constructor(url: string | URL) {
    super(); this.url = String(url);
    window.addEventListener("layout-fixture-refresh", this.refresh);
    queueMicrotask(() => { this.onopen?.(new Event("open")); this.refresh(); });
  }
  close() { this.closed = true; window.removeEventListener("layout-fixture-refresh", this.refresh); }
}
// The fixture has no wall-clock status transitions; a test explicitly refreshes the roster.
Object.defineProperty(window, "EventSource", { value: LayoutEvents });
Object.defineProperty(window, "WebSocket", { value: class extends demoSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const machine = new URL(String(url), location.href).searchParams.get("machine_id") ?? "local";
    frames.push({ machine, type: "connect" });
    // The demo constructor returns its own socket object; wrap that object's method.
    const send = this.send.bind(this);
    this.send = (data) => {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        frames.push({ machine, type: frame.type, pane_id: frame.pane_id });
      }
      send(data);
    };
  }
} });
Object.assign(window, { layoutFixture: {
  requests, frames,
  setRemoteState(state: Machine["state"]) { remoteState = state; window.dispatchEvent(new Event("layout-fixture-refresh")); },
  async snapshot(): Promise<SessionSnapshot> { return (await (await demoFetch("/api/session")).json()).snapshot; },
} });
