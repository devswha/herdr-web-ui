import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { agentContext, agentTabName, groupRows, paneMark, sidebarAgents, type SidebarAgent } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { AgentMark } from "./AgentMark.tsx";
import { BackgroundBadge, displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

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

interface AgentRow { machine: Machine; entry: SidebarAgent }

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 * In herdr's order each workspace's agents on a PC sit in a card under its name; Activity order
 * mixes workspaces, so its rows stand alone.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const { settings } = useSettings();
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  }), [machines, byActivity, activity]);
  const groups = useMemo(() => byActivity ? null : groupRows(rows, ({ machine, entry }) => JSON.stringify([machine.id, entry.workspace.workspace_id])), [rows, byActivity]);
  // herdr names a PC only beside another: the rows' line, and a card's head, do the same
  const machineName = (machine: Machine): string | null => machines.length > 1 ? machine.name : null;

  const agentItem = ({ machine, entry }: AgentRow, grouped: boolean) => {
    const { pane, workspace, tab, agent, agentLabel } = entry;
    const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
    const online = machine.state === "connected";
    const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const parts = { agentLabel, title, machineName: machineName(machine), workspaceLabel: workspace.label, tabName: agentTabName(tab, tabs, t) };
    // a row in a card leaves its place to the card's head; the tooltip still says all of it
    const place = agentContext(parts).join(" · ");
    const context = grouped ? agentContext({ ...parts, grouped }).join(" · ") : place;
    const tooltip = [...new Set([pane.pane_id, title, place, agent?.name, agent?.display_agent, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
    return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id}>
      <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}>
        {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
        <AgentRowBody mark={paneMark(entry)} title={title} context={context} backgroundTasks={online ? pane.background_tasks : 0} status={online ? activity.status(machine.id, pane) : undefined} />
      </button>
    </li>;
  };

  return <section className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <ul className="agent-list">
        {groups ? groups.map(({ key, rows: members }, index) => {
          const { machine, entry } = members[0]!;
          const headId = `${listId}-group-${index}`;
          const name = [machineName(machine), entry.workspace.label].filter(Boolean).join(" · ");
          // the head is the card's name, not a control: a row opens a pane, and the workspace list opens workspaces
          return <li className={`agent-group${machine.state === "connected" ? "" : " is-offline"}`} key={key}>
            <div className="agent-group-head" id={headId}>
              <span className="agent-group-mark" aria-hidden="true"><Folder /></span>
              <span className="agent-group-name" title={name}>{name}</span>
            </div>
            <ul className="agent-group-rows" aria-labelledby={headId}>{members.map((row) => agentItem(row, true))}</ul>
          </li>;
        }) : rows.map((row) => agentItem(row, false))}
      </ul>}
    </div>
  </section>;
}
