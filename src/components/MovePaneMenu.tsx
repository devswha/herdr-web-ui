/**
 * The "Move pane to…" menu: the row menu again, under the button the first one opened from,
 * listing where the pane can go (lib/paneMove.ts) with the pane's name over the items. A pick
 * asks the server once; the answer names the pane where it now stands, under a new id when it
 * left its workspace, and the caller follows it. A refusal is handed back in words.
 */
import { Folder, FolderPlus, PanelTop, Plus, type LucideIcon } from "lucide-react";

import "./MovePaneMenu.css";

import type { PaneInfo, PaneMoved, SessionSnapshot } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { paneMoveTargets, type MoveTarget } from "../lib/paneMove.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

const ICONS: Record<MoveTarget["kind"], LucideIcon> = { "new-tab": Plus, tab: PanelTop, workspace: Folder, "new-workspace": FolderPlus };

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

interface Props {
  anchor: HTMLElement;
  align?: "start" | "end";
  snapshot: SessionSnapshot;
  pane: PaneInfo;
  /** the pane as its row or tab names it */
  paneTitle: string;
  onMoved: (moved: PaneMoved) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export function MovePaneMenu({ anchor, align, snapshot, pane, paneTitle, onMoved, onError, onClose }: Props) {
  const t = useT();
  const { movePane } = useMachineApi();
  const items: RowMenuItem[] = paneMoveTargets(snapshot, pane, t).map((target) => ({
    id: target.id,
    label: target.label,
    icon: ICONS[target.kind],
    divider: target.divider,
    run: () => { void movePane(pane.pane_id, target.destination).then(onMoved, (reason: unknown) => onError(said(reason))); },
  }));
  return (
    <RowMenu
      anchor={anchor}
      title={t("Move {pane} to", { pane: paneTitle })}
      header={(
        <div className="move-pane-head">
          <span className="move-pane-head-title">{t("Move to")}</span>
          <span className="move-pane-head-pane">{paneTitle}</span>
        </div>
      )}
      items={items}
      align={align}
      onClose={onClose}
    />
  );
}
