/**
 * The tabs of the selected pane's workspace, above its pane, as herdr's own tab row: shown once
 * the workspace has more than one pane (a second tab, or a tab split in the TUI), with a `+`
 * that opens the New tab dialog. A tab opens the pane last viewed in it, else the one herdr has
 * focused there, else its first. The app shows one pane at a time, so a tab with several panes
 * carries a picker of them beside its name.
 */
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, Plus, Terminal } from "lucide-react";

import "./TabStrip.css";

import type { HerdrTab, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { knownStatus } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

/** herdr names a tab by its number until it is renamed ("2"): the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const label = tab.label.trim();
  return label === "" || label === String(tab.number) ? t("Tab {n}", { n: tab.number }) : label;
}

/** the pane each tab was last seen on, per PC: a tab clicked again opens where it was left */
const lastViewed = new Map<string, string>();

export interface TabStripProps {
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  selectedPane: PaneInfo;
  onSelectPane: (paneId: string) => void;
  onNewTab: () => void;
}

export function TabStrip({ snapshot, workspace, selectedPane, onSelectPane, onNewTab }: TabStripProps) {
  const t = useT();
  const machineId = useMachineId();
  const [picker, setPicker] = useState<{ anchor: HTMLElement; tab: HerdrTab } | null>(null);
  const panes = snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).sort((a, b) => a.number - b.number);

  useEffect(() => {
    lastViewed.set(`${machineId}:${selectedPane.tab_id}`, selectedPane.pane_id);
  }, [machineId, selectedPane.tab_id, selectedPane.pane_id]);

  // a picker whose tab left (closed in the TUI) goes with it
  useEffect(() => {
    if (picker && !tabs.some((tab) => tab.tab_id === picker.tab.tab_id)) setPicker(null);
  });

  if (panes.length < 2) return null;

  const panesOf = (tab: HerdrTab): PaneInfo[] => panes.filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => {
    const own = panesOf(tab);
    const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
    return pick(lastViewed.get(`${machineId}:${tab.tab_id}`))
      ?? pick(snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id)
      ?? own.find((pane) => pane.focused)
      ?? own[0];
  };

  // arrows move between the tabs; Enter or Space on one opens it, as any button
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const openPicker = (event: MouseEvent<HTMLButtonElement>, tab: HerdrTab): void => {
    setPicker(picker?.tab.tab_id === tab.tab_id ? null : { anchor: event.currentTarget, tab });
  };

  const pickerItems = (tab: HerdrTab): RowMenuItem[] => panesOf(tab).map((pane) => ({
    id: pane.pane_id,
    label: displayPaneTitle(pane),
    icon: Terminal,
    glyph: pane.agent ? <AgentMark agent={pane.agent} size={16} /> : undefined,
    current: pane.pane_id === selectedPane.pane_id,
    run: () => onSelectPane(pane.pane_id),
  }));

  return (
    <>
      <div className="tab-strip" role="tablist" aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const active = tab.tab_id === selectedPane.tab_id;
          const own = panesOf(tab);
          const status = knownStatus(tab.agent_status);
          const pickerOpen = picker?.tab.tab_id === tab.tab_id;
          return (
            <div className={`tab-strip-item${active ? " is-active" : ""}`} key={tab.tab_id}>
              <button
                type="button"
                role="tab"
                className="tab-strip-tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length })}
                onClick={() => {
                  const pane = paneFor(tab);
                  if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
                }}
              >
                {(status === "working" || status === "blocked" || status === "done") && <span className="tab-strip-dot" data-status={status} aria-hidden="true" />}
                <span className="tab-strip-label">{tabLabel(tab, t)}</span>
              </button>
              {own.length > 1 && (
                <button type="button" className="tab-strip-panes" aria-label={t("Panes in {tab}", { tab: tabLabel(tab, t) })} aria-haspopup="menu" aria-expanded={pickerOpen} onClick={(event) => openPicker(event, tab)}>
                  <ChevronDown aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="tab-strip-add" aria-label={t("New tab")} title={t("New tab")} onClick={onNewTab}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      {picker && <RowMenu anchor={picker.anchor} title={t("Panes in {tab}", { tab: tabLabel(picker.tab, t) })} items={pickerItems(picker.tab)} onClose={() => setPicker(null)} />}
    </>
  );
}
