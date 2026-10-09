import { createContext, useContext } from "react";
import type { DragEvent } from "react";
import type { PaneTarget } from "../../shared/machines.ts";

export const PANE_DRAG_TYPE = "application/x-herdr-pane-view";

export interface PaneDockActions {
  readonly viewNumbers?: ReadonlyMap<string, number>;
  readonly startDrag: (target: PaneTarget) => void;
  readonly endDrag: () => void;
  readonly place: (target: PaneTarget, opener?: HTMLElement) => void;
}

export const PaneDockContext = createContext<PaneDockActions | null>(null);
export const usePaneDock = () => useContext(PaneDockContext);

export function startPaneDrag(event: DragEvent<HTMLElement>, target: PaneTarget, actions: PaneDockActions | null): void {
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData(PANE_DRAG_TYPE, JSON.stringify(target));
  actions?.startDrag(target);
}

export function readPaneDrag(data: Pick<DataTransfer, "getData">): PaneTarget | null {
  try {
    const value: unknown = JSON.parse(data.getData(PANE_DRAG_TYPE));
    if (typeof value !== "object" || value === null || !("machine_id" in value) || !("pane_id" in value)) return null;
    if (typeof value.machine_id !== "string" || !value.machine_id || typeof value.pane_id !== "string" || !value.pane_id) return null;
    return { machine_id: value.machine_id, pane_id: value.pane_id };
  } catch { return null; } // unrelated or malformed drag payload
}
