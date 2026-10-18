import { useState } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings } from "lucide-react";
import type { Machine, MachineState } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { SidebarActivityProvider, useSidebarActivityState } from "../lib/sidebarActivity.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { saysHerdrAway } from "../lib/userError.ts";

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone, every other state also writes its word under the name. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection error",
};

interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; actions: AppActions; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  // both lists draw from it: live counters per PC (lib/sidebarActivity.tsx)
  const activity = useSidebarActivityState(props.machines);
  // the roster's wait is a live region that is in the list from its first render, clipped while empty (never
  // display: none), and its words land a frame after it (lib/useAnnouncedText.ts)
  const loadingWords = useAnnouncedText(props.machines.length === 0 ? t("Loading…") : null);
  return <SidebarActivityProvider value={activity}><div className="sidebar-shell">
    <div className="machine-list" aria-label={t("Workspaces")}>
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      <p className={loadingWords === null ? "visually-hidden" : "tree-state"} role="status">{loadingWords}</p>
    </div>
    <AgentSidebar machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} onSelect={props.onSelect} />
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action sidebar-footer-settings" aria-label={t("Settings")} title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" /></button>
      </div>
    </footer>
  </div></SidebarActivityProvider>;
}

function MachineGroup({ machine, ...props }: Props & { machine: Machine }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`herdr-web-ui:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const online = machine.state === "connected";
  const nextStep = machine.error !== null && saysHerdrAway(machine.error) ? t("Start herdr on this PC, or check HERDR_SOCKET.") : null;
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(`herdr-web-ui:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  // the PC's name is the head of its workspaces, and the caret beside its + the one fold over them
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}${online ? "" : " is-offline"}`} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      <div className="machine-title">
        <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
        <span className="machine-name">{machine.name}</span>
        <span className={`machine-dot is-${machine.state}`} title={t(STATE_WORD[machine.state])} aria-hidden="true" />
      </div>
      {/* the fold over this PC's workspaces sits beside the + */}
      <button className="sidebar-row-action machine-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} title={collapsed ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} onClick={toggle}>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
      <button className="sidebar-row-action machine-new" disabled={!online} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    <p className={`machine-state is-${machine.state}${online ? " visually-hidden" : ""}`} role="status" title={machine.error ?? undefined}>
      <span className="machine-state-word">{t(STATE_WORD[machine.state])}</span>
      {machine.error && <span className="machine-state-detail">{machine.error}</span>}
      {nextStep !== null && <span className="machine-state-next">{nextStep}</span>}
    </p>
    {!collapsed && <div className={online ? "" : "machine-offline"} inert={!online}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} /></MachineContext.Provider>}
    </div>}
  </section>;
}
