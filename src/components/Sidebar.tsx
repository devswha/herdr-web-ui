import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, Download, Folder, GripVertical, Layers, Pencil, Plus, Settings, Terminal, X } from "lucide-react";

import "./Sidebar.css";

import type { AgentStatus, PaneInfo, SessionSnapshot, WorkspaceInfo, HerdrPane } from "../../shared/protocol.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { AgentMark } from "./AgentMark.tsx";
import { UsageMeters } from "./UsageMeters.tsx";
import { folderName, shortPathTitle } from "../lib/paneName.ts";
import { useT } from "../lib/i18n.ts";
import { groupDirectories } from "../lib/directoryGroups.ts";
import { useSettings, type SidebarGrouping } from "../lib/settings.ts";

const CLOSE_ARM_MS = 3000;
const ERROR_NOTE_MS = 5000;

/** Folder folds belong to a PC and full path, not an individual workspace. */
const collapsedKey = (machineId: string, groupKey: string) => {
  const workspace = groupKey.startsWith("workspace:");
  return `herdr-web-ui:${workspace ? "workspace" : "directory"}-collapsed:${machineId}:${groupKey.slice(workspace ? "workspace:".length : "folder:".length)}`;
};
function storedCollapsed(machineId: string, directoryKeys: string[]): Set<string> {
  const collapsed = new Set<string>();
  try {
    for (const id of directoryKeys) if (localStorage.getItem(collapsedKey(machineId, id)) === "1") collapsed.add(id);
  } catch { /* storage denied: nothing is folded */ }
  return collapsed;
}

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
const AGENT_CHROME = /^\u03c0\s*[^\p{L}\p{N}\s]?\s*/u;

function stripPaneChrome(title: string, agent: string | null | undefined): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  return agent ? shellStripped.replace(AGENT_CHROME, "") : shellStripped;
}

export { paneTitle };

/**
 * The title a row or the header shows: the user's label, else the live title minus its chrome,
 * a working directory written out shortened to its last folder (lib/paneName.ts).
 */
export function displayPaneTitle(pane: PaneInfo): string {
  return pane.label?.trim() || shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent)) || pane.pane_id;
}

/** herdr could not bring this pane back after a restart (0.9.3+ `restore_error`): its reason, on hover. */
export function RestoreErrorBadge({ reason }: { reason: string }) {
  const t = useT();
  return <span className="badge badge-restore-error" title={reason}>{t("NOT RESTORED")}</span>;
}

export function StatusBadge({ status }: { status?: AgentStatus }) {
  const t = useT();
  const value = knownStatus(status);
  return (
    <span className={`badge badge-${value}`} data-status={value} title={t("Agent {status}", { status: t(STATUS_WORD[value]) })}>
      {t(STATUS_WORD[value])}
    </span>
  );
}

/**
 * Background tasks an agent started that still run (OmO's `task` children): the main turn can be
 * done while they work, and they wake the session by themselves. A count beside the state word,
 * not a state of its own: DONE stays the moment the agent answered.
 */
export function BackgroundBadge({ count }: { count?: number }) {
  const t = useT();
  if (!count || count <= 0) return null;
  const label = t("Background tasks running: {count}", { count });
  return (
    <span className="badge badge-background" title={label} aria-label={label} data-testid="background-tasks">
      <Layers aria-hidden="true" />{count}
    </span>
  );
}

function cwdBasename(cwd: string | null | undefined): string {
  return cwd ? folderName(cwd) : "unknown directory";
}

interface InlineError {
  paneId?: string;
  message: string;
}

export interface SidebarProps {
  snapshot: SessionSnapshot | null;
  selectedPaneId: string | null;
  actions: AppActions;
  version: string | null;
  embedded?: boolean;
}

export function Sidebar({ snapshot, selectedPaneId, actions, version, embedded = false }: SidebarProps) {
  const t = useT();
  const { settings } = useSettings();
  const byFolder = settings.sidebarGrouping === "directory";
  const machineId = useMachineId();
  const { closePane, moveWorkspace, renamePane, renameWorkspace } = useMachineApi();
  const [armedId, setArmedId] = useState<string | null>(null);
  const [editingPaneId, setEditingPaneId] = useState<string | null>(null);
  const [paneLabel, setPaneLabel] = useState("");
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([]);
  const [dragWorkspaceId, setDragWorkspaceId] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<InlineError | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => storedCollapsed(machineId, snapshot ? [...snapshot.workspaces.map((workspace) => `workspace:${workspace.workspace_id}`), ...groupDirectories(snapshot.workspaces, snapshot.panes).map((group) => `folder:${group.key}`)] : []));
  const armTimer = useRef<number | null>(null);
  const unfoldedFor = useRef<Partial<Record<SidebarGrouping, string>>>({});
  const { canInstall, install } = useInstallPrompt();

  const setGroupCollapsed = (groupKey: string, collapsed: boolean): void => {
    setCollapsedGroups((current) => {
      if (current.has(groupKey) === collapsed) return current;
      const next = new Set(current);
      if (collapsed) next.add(groupKey); else next.delete(groupKey);
      return next;
    });
    try {
      if (collapsed) localStorage.setItem(collapsedKey(machineId, groupKey), "1");
      else localStorage.removeItem(collapsedKey(machineId, groupKey));
    } catch {}
  };

  useEffect(() => () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
  }, []);

  useEffect(() => {
    if (inlineError === null) return;
    const timer = window.setTimeout(() => setInlineError(null), ERROR_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [inlineError]);

  useEffect(() => {
    if (!snapshot) {
      setWorkspaceOrder([]);
      return;
    }
    const serverOrder = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    setWorkspaceOrder((current) => current.join("\u0000") === serverOrder.join("\u0000") ? current : serverOrder);
    // New folders bring their stored fold state after reconnecting or creating a session.
    setCollapsedGroups((current) => {
      const keys = [...serverOrder.map((id) => `workspace:${id}`), ...groupDirectories(snapshot.workspaces, snapshot.panes).map((group) => `folder:${group.key}`)];
      const stored = storedCollapsed(machineId, keys.filter((id) => !current.has(id)));
      return stored.size === 0 ? current : new Set([...current, ...stored]);
    });
  }, [snapshot, machineId]);

  // Reveal a newly selected pane once per mode; toggling back preserves its deliberate fold.
  useEffect(() => {
    if (!selectedPaneId || !snapshot) return;
    const pane = snapshot.panes.find((pane) => pane.pane_id === selectedPaneId);
    if (!pane) return;
    const directory = byFolder ? groupDirectories(snapshot.workspaces, snapshot.panes).find((group) => group.workspaces.some((entry) => entry.panes.some((pane) => pane.pane_id === selectedPaneId))) : null;
    if (byFolder && !directory) return;
    const groupKey = directory ? `folder:${directory.key}` : `workspace:${pane.workspace_id}`;
    const opened = JSON.stringify([machineId, selectedPaneId, groupKey]);
    if (unfoldedFor.current[settings.sidebarGrouping] === opened) return;
    unfoldedFor.current[settings.sidebarGrouping] = opened;
    setGroupCollapsed(groupKey, false);
  }, [selectedPaneId, snapshot, machineId, settings.sidebarGrouping, byFolder]);

  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    const byId = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
    return workspaceOrder.map((id) => byId.get(id)).filter((workspace): workspace is WorkspaceInfo => workspace !== undefined);
  }, [snapshot, workspaceOrder]);
  const directories = useMemo(() => groupDirectories(orderedWorkspaces, snapshot?.panes ?? []), [orderedWorkspaces, snapshot?.panes]);
  const workspacePaneCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pane of snapshot?.panes ?? []) counts.set(pane.workspace_id, (counts.get(pane.workspace_id) ?? 0) + 1);
    return counts;
  }, [snapshot?.panes]);

  const noteError = (message: string, paneId?: string): void => setInlineError({ message, paneId });

  const closePaneClick = (paneId: string): void => {
    setInlineError(null);
    if (armedId !== paneId) {
      setArmedId(paneId);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => {
        armTimer.current = null;
        setArmedId(null);
      }, CLOSE_ARM_MS);
      return;
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    armTimer.current = null;
    setArmedId(null);
    void closePane(paneId).catch((reason: unknown) => {
      noteError(t("Close failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }), paneId);
    });
  };

  const beginPaneRename = (pane: PaneInfo): void => {
    setEditingPaneId(pane.pane_id);
    setPaneLabel(pane.label ?? "");
  };

  const savePaneRename = (paneId: string): void => {
    const label = paneLabel.trim();
    setEditingPaneId(null);
    void renamePane(paneId, label).catch((reason: unknown) => {
      noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }), paneId);
    });
  };

  // By folder, one workspace can show under several folders: only the copy that was clicked edits.
  // Two mounted inputs would take the focus from each other, and the blur closes both.
  const beginWorkspaceRename = (workspace: WorkspaceInfo, scope: string): void => {
    setEditingWorkspaceId(`${scope}\u0000${workspace.workspace_id}`);
    setWorkspaceLabel(workspace.label);
  };

  const saveWorkspaceRename = (workspaceId: string): void => {
    const label = workspaceLabel.trim();
    setEditingWorkspaceId(null);
    void renameWorkspace(workspaceId, label).catch((reason: unknown) => {
      noteError(t("Rename failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }));
    });
  };

  const reorderWorkspace = (workspaceId: string, insertIndex: number): void => {
    const sourceIndex = workspaceOrder.indexOf(workspaceId);
    if (sourceIndex < 0) return;
    const boundedIndex = Math.max(0, Math.min(workspaceOrder.length - 1, insertIndex));
    if (sourceIndex === boundedIndex) return;
    const previous = workspaceOrder;
    const next = [...workspaceOrder];
    next.splice(sourceIndex, 1);
    next.splice(boundedIndex, 0, workspaceId);
    setWorkspaceOrder(next);
    void moveWorkspace(workspaceId, boundedIndex).catch((reason: unknown) => {
      setWorkspaceOrder(previous);
      noteError(t("Reorder failed: {reason}", { reason: reason instanceof Error ? reason.message : String(reason) }));
    });
  };

  const onDragStart = (event: DragEvent<HTMLElement>, workspaceId: string): void => {
    setDragWorkspaceId(workspaceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-herdr-workspace", JSON.stringify({ machine_id: machineId, workspace_id: workspaceId }));
  };

  const onDrop = (event: DragEvent<HTMLElement>, targetWorkspaceId: string): void => {
    event.preventDefault();
    let payload: { machine_id?: string; workspace_id?: string };
    try { payload = JSON.parse(event.dataTransfer.getData("application/x-herdr-workspace")); } catch { return; }
    if (payload.machine_id !== machineId || typeof payload.workspace_id !== "string") return;
    const sourceId = dragWorkspaceId ?? payload.workspace_id;
    setDragWorkspaceId(null);
    reorderWorkspace(sourceId, workspaceOrder.indexOf(targetWorkspaceId));
  };

  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, workspaceId: string): void => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const current = workspaceOrder.indexOf(workspaceId);
    reorderWorkspace(workspaceId, current + (event.key === "ArrowUp" ? -1 : 1));
  };

  const dragHandle = (workspace: WorkspaceInfo, draggable: boolean) => (
    <button
      type="button"
      className="sidebar-drag-handle"
      aria-label={t("Reorder workspace {name}", { name: workspace.label })}
      title={t("Drag to reorder · Alt+↑/↓")}
      draggable={draggable}
      onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
      onDragEnd={() => setDragWorkspaceId(null)}
      onKeyDown={(event) => onHandleKeyDown(event, workspace.workspace_id)}
    >
      <GripVertical aria-hidden="true" />
    </button>
  );

  const renderWorkspace = (workspace: WorkspaceInfo, visiblePanes: PaneInfo[], scope = "") => {
    if (visiblePanes.length === 0) return null;
    // Only folder mode merges a single-pane workspace into its row. Count the
    // whole workspace so one split across folders keeps its rename heading.
    const merged = byFolder && (workspacePaneCounts.get(workspace.workspace_id) ?? visiblePanes.length) === 1;
    const groupKey = `workspace:${workspace.workspace_id}`;
    const collapsed = !byFolder && collapsedGroups.has(groupKey);
    return (
      <section
        className={`workspace${dragWorkspaceId === workspace.workspace_id ? " is-dragging" : ""}${collapsed ? " is-collapsed" : ""}`}
        key={workspace.workspace_id}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => onDrop(event, workspace.workspace_id)}
      >
        {!merged && (
          <header
            className="workspace-header"
            draggable
            onDragStart={(event) => onDragStart(event, workspace.workspace_id)}
            onDragEnd={() => setDragWorkspaceId(null)}
          >
            {dragHandle(workspace, false)}
            {!byFolder && <button type="button" className="workspace-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand workspace {name}", { name: workspace.label }) : t("Collapse workspace {name}", { name: workspace.label })} title={collapsed ? t("Show panes") : t("Hide panes")} onClick={(event) => { event.stopPropagation(); setGroupCollapsed(groupKey, !collapsed); }}>
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
            </button>}
            <span className="workspace-number">{workspace.number}</span>
            {editingWorkspaceId === `${scope}\u0000${workspace.workspace_id}` ? (
              <input
                className="input workspace-rename-input"
                aria-label={t("Workspace name")}
                autoFocus
                value={workspaceLabel}
                onChange={(event) => setWorkspaceLabel(event.target.value)}
                onBlur={() => setEditingWorkspaceId(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") saveWorkspaceRename(workspace.workspace_id);
                  if (event.key === "Escape") setEditingWorkspaceId(null);
                }}
              />
            ) : (
              <span className="workspace-label" title={workspace.label} onDoubleClick={() => beginWorkspaceRename(workspace, scope)}>
                {workspace.label}
              </span>
            )}
            <StatusBadge status={workspace.agent_status} />
            <button type="button" className="sidebar-row-action workspace-rename" aria-label={t("Rename workspace {name}", { name: workspace.label })} onClick={() => beginWorkspaceRename(workspace, scope)}>
              <Pencil aria-hidden="true" />
            </button>
          </header>
        )}

        {!collapsed && <ul className="pane-list">
          {visiblePanes.map((pane) => {
            const fullTitle = paneTitle(pane);
            const displayTitle = displayPaneTitle(pane);
            // The group header already names one of the two: a workspace's rows name the folder, a
            // folder's rows the workspace. A workspace is usually named after its folder, and a shell
            // titled by it: the folder shows only when neither already says it.
            const folder = cwdBasename(pane.cwd);
            const place = byFolder ? workspace.label : folder === displayTitle || folder === workspace.label ? "" : folder;
            const selected = pane.pane_id === selectedPaneId;
            const editing = editingPaneId === pane.pane_id;
            return (
              <li className={`pane-item${selected ? " is-selected" : ""}`} key={pane.pane_id}>
                <div className="pane-row">
                  {merged && dragHandle(workspace, true)}
                  <div
                    className="pane-select"
                    role="button"
                    tabIndex={0}
                    aria-current={selected ? "true" : undefined}
                    title={`${pane.pane_id} — ${fullTitle}${pane.cwd ? ` — ${pane.cwd}` : ""}`}
                    onClick={() => actions.selectPane(pane.pane_id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      actions.selectPane(pane.pane_id);
                    }}
                  >
                    <span className={`agent-mark-holder${pane.agent ? "" : " is-shell"}`} title={pane.agent ?? t("Shell")}>
                      {pane.agent ? <AgentMark agent={pane.agent} size={22} /> : <Terminal aria-hidden="true" />}
                    </span>
                    <span className="pane-copy">
                      <span className="pane-primary">
                        {editing ? (
                          <input
                            className="input pane-rename-input"
                            aria-label={t("Pane name")}
                            autoFocus
                            value={paneLabel}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => setPaneLabel(event.target.value)}
                            onBlur={() => setEditingPaneId(null)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") savePaneRename(pane.pane_id);
                              if (event.key === "Escape") setEditingPaneId(null);
                            }}
                          />
                        ) : (
                          <span className="pane-title">{displayTitle}</span>
                        )}
                      </span>
                      <span className="pane-meta">
                        {pane.restore_error ? <RestoreErrorBadge reason={pane.restore_error} /> : <StatusBadge status={pane.agent_status} />}
                        <BackgroundBadge count={(pane as HerdrPane).background_tasks} />
                        {place && <span className="pane-subtitle">{place}</span>}
                      </span>
                    </span>
                  </div>
                  <div className="pane-actions">
                    <button type="button" className="sidebar-row-action" aria-label={t("Rename {title}", { title: displayTitle })} title={t("Rename pane")} onClick={() => beginPaneRename(pane)}>
                      <Pencil aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={`sidebar-row-action pane-close${armedId === pane.pane_id ? " is-armed" : ""}`}
                      aria-label={armedId === pane.pane_id ? t("Confirm close {title}", { title: displayTitle }) : t("Close {title}", { title: displayTitle })}
                      title={armedId === pane.pane_id ? t("Click again to close") : t("Close pane")}
                      onClick={() => closePaneClick(pane.pane_id)}
                    >
                      {armedId === pane.pane_id ? <span>{t("sure?")}</span> : <X aria-hidden="true" />}
                    </button>
                  </div>
                </div>
                {inlineError?.paneId === pane.pane_id && <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>}
              </li>
            );
          })}
        </ul>}
      </section>
    );
  };

  return (
    <div className={embedded ? "machine-workspaces" : "sidebar-shell"}>
      {!embedded && <div className="sidebar-topbar">
        <button type="button" className="btn sidebar-new-session" onClick={actions.openNewSession}>
          <Plus aria-hidden="true" />
          {t("New session")}
        </button>
      </div>}

      <nav className="sidebar-list" aria-label={t("Herdr workspaces")}>
        {!snapshot && <p className="tree-state" role="status">{t("Loading workspaces…")}</p>}
        {snapshot && snapshot.workspaces.length === 0 && (
          <p className="tree-state tree-state-empty" role="status">{t("No workspaces yet")}</p>
        )}
        {byFolder ? directories.map((directory) => {
          const collapsed = collapsedGroups.has(`folder:${directory.key}`);
          const name = directory.path ? cwdBasename(directory.path) : directory.workspaces[0]?.workspace.label;
          return <section className={`directory-group${collapsed ? " is-collapsed" : ""}`} key={directory.key} data-directory={directory.path ?? directory.key}>
            <button type="button" className="directory-header" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand folder {name}", { name: directory.path ?? name ?? "" }) : t("Collapse folder {name}", { name: directory.path ?? name ?? "" })} title={directory.path ?? name} onClick={() => setGroupCollapsed(`folder:${directory.key}`, !collapsed)}>
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              <Folder aria-hidden="true" />
              <span className="directory-copy"><span className="directory-name">{name}</span>{directory.path && <span className="directory-path">{directory.path}</span>}</span>
              <span className="workspace-number">{directory.paneCount}</span>
            </button>
            {!collapsed && <div className="directory-contents">{directory.workspaces.map(({ workspace, panes: visiblePanes }) => {
              return renderWorkspace(workspace, visiblePanes, directory.key);
        })}</div>}
          </section>;
        }) : orderedWorkspaces.map((workspace) => renderWorkspace(workspace, snapshot?.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? []))}
        {inlineError && inlineError.paneId === undefined && (
          <p className="sidebar-inline-error" role="alert">{inlineError.message}</p>
        )}
      </nav>

      {!embedded && <footer className="sidebar-footer">
        {canInstall && (
          <button type="button" className="btn btn-ghost sidebar-footer-action" onClick={() => void install().catch((reason: unknown) => noteError(reason instanceof Error ? reason.message : String(reason)))}>
            <Download aria-hidden="true" />
            {t("Install app")}
          </button>
        )}
        <div className="sidebar-footer-row">
          <button type="button" className="btn btn-ghost sidebar-footer-action" onClick={actions.openSettings}>
            <Settings aria-hidden="true" />
            {t("Settings")}
          </button>
          <UsageMeters />
        </div>
        <div className="sidebar-brandline">
          <span className="sidebar-app-name">herdr web ui</span>
          <span className="pill">herdr {version ?? "offline"}</span>
        </div>
      </footer>}
    </div>
  );
}
