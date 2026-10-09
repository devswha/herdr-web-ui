import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, Terminal, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import { MachineContext, useMachineApi } from "../lib/machineContext.tsx";
import { agentContext, agentTabName, paneMark, sidebarAgents } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { tabCloseCost, type TabCloseCost } from "../lib/tabClose.ts";
import { customTabLabel } from "../lib/tabName.ts";
import { AgentMark } from "./AgentMark.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { BackgroundBadge, displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

const ERROR_NOTE_MS = 6000;

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  title: string;
  context: string;
  backgroundTasks?: number;
  status?: AgentStatus;
}

/**
 * One agent in a list: the coding agent's mark, what it is working on, who and where it is, and
 * how it is doing.
 */
function AgentRowBody({ mark, title, context, backgroundTasks, status }: AgentRowBodyProps) {
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      <span className="agent-title">{title}</span>
      {context && <span className="agent-context">{context}</span>}
    </span>
    <span className="agent-row-status"><BackgroundBadge count={backgroundTasks} /><StatusBadge status={status} compact /></span>
  </>;
}

/**
 * The row whose menu is open, by ids: what its item does is read from the PC's roster as it is
 * then. `ask` is the question on screen once the close has to ask first.
 */
interface RowTarget { anchor: HTMLElement; machineId: string; paneId: string; tabId: string; title: string; context: string; ask?: Exclude<TabCloseCost, null> }

interface AgentTabActionsProps {
  target: RowTarget;
  machine: Machine;
  /** tabs whose close is on its way, per PC: a second press does not send another */
  closing: Set<string>;
  onChange(target: RowTarget | null): void;
  onError(message: string): void;
}

/**
 * An agent row's menu: herdr's Close tab, for the tab the agent runs in. It asks first on the
 * tab strip's terms (lib/tabClose.ts), and also when the tab holds panes beside the agent's: the
 * row stands for one pane, and the others would go unseen. Drawn inside the row's PC's
 * MachineContext, so the close goes to that PC.
 */
function AgentTabActions({ target, machine, closing, onChange, onError }: AgentTabActionsProps) {
  const t = useT();
  const { closeTab } = useMachineApi();
  const dismiss = useCallback(() => onChange(null), [onChange]);
  const snapshot = machine.snapshot;
  const tab = snapshot?.tabs.find((candidate) => candidate.tab_id === target.tabId);
  if (!snapshot || !tab) return null;
  const tabs = snapshot.tabs.filter((candidate) => candidate.workspace_id === tab.workspace_id);
  const panes = rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === tab.workspace_id));
  // a tab herdr names by its place ("Tab 1") is named by the row the menu came from
  const name = customTabLabel(tab, tabs.indexOf(tab) + 1 || tab.number) ?? target.title;
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === tab.workspace_id)?.label ?? "";

  const close = async (): Promise<void> => {
    const key = `${machine.id}:${tab.tab_id}`;
    if (closing.has(key)) return;
    closing.add(key);
    try { await closeTab(tab.tab_id); }
    finally { closing.delete(key); }
  };

  if (target.ask) {
    const body = target.ask === "last"
      ? t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace })
      : target.ask === "busy"
        ? t("An agent in it is still at work, and stops with the tab.")
        : t("It holds {n} panes, and they all close with it.", { n: panes.filter((pane) => pane.tab_id === tab.tab_id).length });
    // the row is gone with its tab: focus goes where a closed row's goes
    return <ConfirmDialog title={t("Close tab {name}?", { name })} body={body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(); dismiss(); focusWorkspaceListToggle(); }} onClose={dismiss} />;
  }

  const requestClose = (): void => {
    const cost = tabCloseCost(tab.tab_id, tabs.length, panes, { split: true });
    if (cost !== null) { onChange({ ...target, ask: cost }); return; }
    const row = target.anchor;
    void close().then(() => {
      // the menu gave the focus back to the row, which went with the tab; focus that moved on stays
      if (document.activeElement === row || document.activeElement === document.body) focusWorkspaceListToggle();
    }, (reason: unknown) => onError(t("Close failed: {reason}", { reason: said(reason) })));
  };
  return <RowMenu anchor={target.anchor} title={target.title} subtitle={target.context} items={[{ id: "close-tab", label: t("Close tab"), icon: X, danger: true, run: requestClose }]} onClose={dismiss} />;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  onSelect(machineId: string, paneId: string): void;
}

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 * A right-click on a row (the menu key and Shift+F10 too, and a long press where the browser
 * sends one) opens its menu, which closes the agent's tab.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const [target, setTarget] = useState<RowTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closing = useRef(new Set<string>());
  const { settings } = useSettings();
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry) => ({ machine, entry }));
  }), [machines, byActivity, activity]);
  const targetMachine = target ? machines.find((machine) => machine.id === target.machineId) : undefined;

  // a row that left (its pane or tab closed elsewhere) or whose PC went away takes its menu, and
  // its question, with it; focus goes where a closed row's goes
  useEffect(() => {
    if (!target) return;
    const alive = targetMachine?.state === "connected" && targetMachine.snapshot?.panes.some((pane) => pane.pane_id === target.paneId && pane.tab_id === target.tabId);
    if (alive && (target.ask || target.anchor.isConnected)) return;
    setTarget(null);
    focusWorkspaceListToggle();
  });
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  // a row that cannot act (its PC away, a pane herdr lists without its tab) keeps the browser's menu
  const openMenu = (event: MouseEvent<HTMLButtonElement>, machine: Machine, paneId: string, tabId: string | undefined, title: string, context: string): void => {
    if (machine.state !== "connected" || !tabId) return;
    event.preventDefault();
    setError(null);
    const anchor = event.currentTarget;
    setTarget(target?.anchor === anchor ? null : { anchor, machineId: machine.id, paneId, tabId, title, context });
  };

  return <section className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <ul className="agent-list">
        {rows.map(({ machine, entry }) => {
          const { pane, workspace, tab, agent, agentLabel } = entry;
          const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
          const online = machine.state === "connected";
          const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
          const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
          const tabName = agentTabName(tab, tabs, t);
          const context = agentContext({ agentLabel, title, machineName: machines.length > 1 ? machine.name : null, workspaceLabel: workspace.label, tabName }).join(" · ");
          const tooltip = [...new Set([pane.pane_id, title, context, agent?.name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
          return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id}>
            <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)} onContextMenu={(event) => openMenu(event, machine, pane.pane_id, tab?.tab_id, title, context)}>
              {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
              <AgentRowBody mark={paneMark(entry)} title={title} context={context} backgroundTasks={online ? pane.background_tasks : 0} status={online ? activity.status(machine.id, pane) : undefined} />
            </button>
          </li>;
        })}
      </ul>}
      {error && <p className="agent-error" role="alert">{error}</p>}
    </div>
    {target && targetMachine && <MachineContext.Provider value={targetMachine.id}>
      <AgentTabActions target={target} machine={targetMachine} closing={closing.current} onChange={setTarget} onError={setError} />
    </MachineContext.Provider>}
  </section>;
}
