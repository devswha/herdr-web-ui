import type { PaneReadOptions } from "../herdr/client.ts";
import type { EventFrame, HerdrSubscription, SubscribeHandlers, Subscription } from "../herdr/client.ts";
import type { AgentManifestInfo, PaneInfo, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import type { SessionSnapshot } from "../../shared/protocol.ts";

export class FakeBoundaryError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`fake Herdr boundary rejected unconfigured RPC: ${method}`);
    this.name = "FakeBoundaryError";
    this.method = method;
  }
}

const rect = { x: 0, y: 0, width: 120, height: 40 } as const;

export const sessionSnapshotValue: SessionSnapshot = {
  agents: [],
  focused_pane_id: "fake-pane",
  focused_tab_id: "tab-1",
  focused_workspace_id: "workspace-1",
  layouts: [{
    area: rect,
    focused_pane_id: "fake-pane",
    panes: [{ focused: true, pane_id: "fake-pane", rect }],
    splits: [],
    tab_id: "tab-1",
    workspace_id: "workspace-1",
    zoomed: false,
  }],
  panes: [{
    agent_status: "idle",
    focused: true,
    pane_id: "fake-pane",
    revision: 1,
    tab_id: "tab-1",
    terminal_id: "terminal-1",
    workspace_id: "workspace-1",
  }],
  protocol: 22,
  tabs: [{ agent_status: "idle", focused: true, label: "Tab 1", number: 1, pane_count: 1, tab_id: "tab-1", workspace_id: "workspace-1" }],
  version: "fake-herdr",
  workspaces: [{ active_tab_id: "tab-1", agent_status: "idle", focused: true, label: "Workspace 1", number: 1, pane_count: 1, tab_count: 1, workspace_id: "workspace-1" }],
};

const manifests: { manifests: AgentManifestInfo[] } = { manifests: [] };
let subscriptionCloseCount = 0;

export function resetFakeHerdrCounters(): void {
  subscriptionCloseCount = 0;
}

export function getFakeHerdrCounters(): Readonly<{ subscriptionCloseCount: number }> {
  return { subscriptionCloseCount };
}

export function herdrSocketPath(): string { return "/fake/herdr.sock"; }
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "HerdrError"; this.code = code; }
}

export async function ping(): Promise<{ version: string; protocol: number }> { return { version: "fake-herdr", protocol: 22 }; }
export async function sessionSnapshot(): Promise<SessionSnapshot> { return sessionSnapshotValue; }
export async function agentManifests(): Promise<{ manifests: AgentManifestInfo[] }> { return manifests; }
export interface WorkspaceCreateResult { type: "workspace_created"; workspace: WorkspaceInfo; tab: TabInfo; root_pane: PaneInfo }
export async function workspaceCreate(_options: { cwd?: string; label?: string }): Promise<WorkspaceCreateResult> {
  throw new FakeBoundaryError("workspace.create");
}
export async function agentStart(_options: { name: string; kind: string; paneId: string; args?: string[]; timeoutMs?: number }): Promise<never> {
  throw new FakeBoundaryError("agent.start");
}
export async function paneRename(_paneId: string, _label: string | null): Promise<void> { throw new FakeBoundaryError("pane.rename"); }
export async function workspaceRename(_workspaceId: string, _label: string): Promise<void> { throw new FakeBoundaryError("workspace.rename"); }
export async function workspaceMove(_workspaceId: string, _insertIndex: number): Promise<void> { throw new FakeBoundaryError("workspace.move"); }
export async function workspaceClose(_workspaceId: string): Promise<void> { throw new FakeBoundaryError("workspace.close"); }
export async function paneRead(_options: PaneReadOptions): Promise<never> { throw new FakeBoundaryError("pane.read"); }
export async function paneSendText(_paneId: string, _text: string): Promise<void> { throw new FakeBoundaryError("pane.send_text"); }
export async function agentPrompt(_target: string, _text: string): Promise<void> { throw new FakeBoundaryError("agent.prompt"); }
export async function paneSendKeys(_paneId: string, _keys: string[]): Promise<void> { throw new FakeBoundaryError("pane.send_keys"); }
export async function paneClose(_paneId: string): Promise<void> { throw new FakeBoundaryError("pane.close"); }
export async function paneGet(_paneId: string, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("pane.get"); }
export async function paneScroll(_paneId: string, _offsetFromBottom: number, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("pane.scroll"); }
export async function paneScrollInfo(_paneId: string, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("pane.scroll_info"); }
export async function paneSelectionRead(_paneId: string, _anchor: unknown, _cursor: unknown, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("pane.selection_read"); }
export async function tabCreate(_options: { workspaceId: string; cwd?: string; label?: string }): Promise<never> { throw new FakeBoundaryError("tab.create"); }
export async function tabRename(_tabId: string, _label: string, _socketPath?: string): Promise<void> { throw new FakeBoundaryError("tab.rename"); }
export async function tabClose(_tabId: string, _socketPath?: string): Promise<void> { throw new FakeBoundaryError("tab.close"); }
export async function worktreeCreate(_options: { workspaceId: string; branch: string; base?: string; label?: string; path?: string }): Promise<never> { throw new FakeBoundaryError("worktree.create"); }
export async function worktreeList(_workspaceId: string, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("worktree.list"); }
export async function worktreeOpen(_options: { workspaceId: string; path?: string; branch?: string; label?: string }): Promise<never> { throw new FakeBoundaryError("worktree.open"); }
export async function worktreeRemove(_workspaceId: string, _force: boolean, _socketPath?: string): Promise<never> { throw new FakeBoundaryError("worktree.remove"); }
export async function integrationList(_socketPath?: string): Promise<{ integrations: never[] }> { return { integrations: [] }; }

export function subscribeEvents(_subscriptions: HerdrSubscription[], handlers: SubscribeHandlers): Subscription {
  handlers.onStarted?.();
  let closed = false;
  return { close() { if (closed) return; closed = true; subscriptionCloseCount += 1; handlers.onClose?.(); } };
}

export async function unexpectedRpc(method: string): Promise<never> { throw new FakeBoundaryError(method); }

export type { EventFrame };
