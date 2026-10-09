import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Columns2, Maximize2, MessageSquare, Rows2, SquareTerminal, X } from "lucide-react";
import type { PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import { cells, dividers, ratioFromPointer, withSplitRatio, type Divider, type SplitAction } from "../lib/split-layout.ts";
import type { PaneView } from "../lib/actions.ts";
import { useT } from "../lib/i18n.ts";
import { startPaneDrag, usePaneDock } from "../lib/paneDock.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { sessionStyle } from "../lib/session-identity.ts";
import { SessionBadge } from "./SessionBadge.tsx";
import { formatKeys, shortcutDisplayKeys } from "../lib/shortcuts.ts";
import { useSettings } from "../lib/settings.ts";
import "./SplitView.css";

export interface SplitViewProps {
  layout: PaneLayoutSnapshot;
  activePaneId: string | null;
  paneLabel: (paneId: string) => string;
  renderPane: (paneId: string, active: boolean) => ReactNode;
  onActivate: (paneId: string) => void;
  onAction: (action: SplitAction, paneId: string) => void;
  onResize: (splitId: string, ratio: number) => void;
  /** the cell's lens, and its switch: each pane keeps its own chat/terminal choice */
  paneView: (paneId: string) => PaneView;
  onPaneView: (paneId: string, view: PaneView) => void;
  error: string | null;
}

const pct = (value: number): string => `${value}%`;

/** A herdr tab drawn the way the CLI lays it out: one live terminal per pane, herdr owns the geometry. */
export function SplitView({ layout, activePaneId, paneLabel, renderPane, onActivate, onAction, onResize, paneView, onPaneView, error }: SplitViewProps) {
  const t = useT();
  const { settings } = useSettings();
  const zoomKeys = formatKeys(shortcutDisplayKeys("zoom-view", settings.shortcutOverrides)).join("");
  const docking = usePaneDock();
  const machineId = useMachineId();
  const hostRef = useRef<HTMLDivElement>(null);
  // a dragged boundary redraws the panes live from the moved ratio; after release that preview
  // stays until herdr's answer replaces the layout (or a short timeout gives up on it)
  const [preview, setPreview] = useState<{ splitId: string; ratio: number; dragging: boolean } | null>(null);
  const shown = preview ? withSplitRatio(layout, preview.splitId, preview.ratio) : layout;
  const visible = cells(shown, activePaneId);
  useEffect(() => {
    if (preview && !preview.dragging) setPreview(null);
    // only a new layout from herdr ends a held preview (preview is read, not a trigger)
  }, [layout]);
  useEffect(() => {
    if (!preview || preview.dragging) return;
    const timer = window.setTimeout(() => setPreview(null), 4000);
    return () => window.clearTimeout(timer);
  }, [preview]);

  // the window listeners of a drag in progress: removed when it ends, is cancelled, or the view goes
  const stopDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDragRef.current?.(), []);

  const startDrag = (divider: Divider) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = hostRef.current;
    if (!host) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stopDragRef.current?.();
    const bounds = host.getBoundingClientRect();
    const fractionOf = (e: { clientX: number; clientY: number }): number => divider.orientation === "vertical"
      ? (e.clientX - bounds.left) / bounds.width
      : (e.clientY - bounds.top) / bounds.height;
    // one redraw per frame however fast the pointer reports
    let frame = 0;
    let latest = divider.ratio;
    const move = (e: PointerEvent): void => {
      latest = ratioFromPointer(layout, divider.splitId, fractionOf(e));
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setPreview({ splitId: divider.splitId, ratio: latest, dragging: true });
      });
    };
    const stop = (): void => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      stopDragRef.current = null;
    };
    const up = (e: PointerEvent): void => {
      stop();
      const ratio = ratioFromPointer(layout, divider.splitId, fractionOf(e));
      setPreview({ splitId: divider.splitId, ratio, dragging: false });
      onResize(divider.splitId, ratio);
    };
    // the browser took the pointer (a gesture, a lost capture): no resize
    const cancel = (): void => {
      stop();
      setPreview(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    stopDragRef.current = stop;
  };

  return (
    <div className="split-view" ref={hostRef}>
      {cells({ ...shown, zoomed: false }, activePaneId).map((original) => {
        const shownCell = visible.find((cell) => cell.paneId === original.paneId);
        const cell = shownCell ?? original;
        const active = cell.paneId === activePaneId && shownCell !== undefined;
        const viewNumber = docking?.viewNumbers?.get(paneStorageId(machineId, cell.paneId));
        return (
          <section
            key={cell.paneId}
            data-pane-id={cell.paneId}
            data-session-number={viewNumber}
            className={`split-cell${active ? " is-active" : ""}`}
            style={{ left: pct(cell.box.left), top: pct(cell.box.top), width: pct(cell.box.width), height: pct(cell.box.height), ...sessionStyle(viewNumber), visibility: shownCell ? undefined : "hidden" }}
            {...(!shownCell ? { inert: "" } : {})}
            onPointerDownCapture={() => { if (!active) onActivate(cell.paneId); }}
            onFocusCapture={() => { if (!active) onActivate(cell.paneId); }}
            aria-label={paneLabel(cell.paneId)}
          >
            <header className="split-cell-head">
              <SessionBadge number={viewNumber} />
              <span className="split-cell-title" draggable
                onDragStart={(event) => startPaneDrag(event, { machine_id: machineId, pane_id: cell.paneId }, docking)}
                onDragEnd={() => docking?.endDrag()}>{paneLabel(cell.paneId)}</span>
              <div className="split-cell-view" role="group" aria-label={t("Pane view")}>
                <button type="button" aria-pressed={paneView(cell.paneId) === "chat"} title={t("Chat")} aria-label={t("Chat")} onClick={() => onPaneView(cell.paneId, "chat")}><MessageSquare /></button>
                <button type="button" aria-pressed={paneView(cell.paneId) === "terminal"} title={t("Terminal")} aria-label={t("Terminal")} onClick={() => onPaneView(cell.paneId, "terminal")}><SquareTerminal /></button>
              </div>
              <span className="split-cell-sep" aria-hidden="true" />
              <button type="button" className="icon-button" title={t("Split right")} aria-label={t("Split right")} onClick={() => onAction({ type: "split", direction: "right" }, cell.paneId)}><Columns2 /></button>
              <button type="button" className="icon-button" title={t("Split down")} aria-label={t("Split down")} onClick={() => onAction({ type: "split", direction: "down" }, cell.paneId)}><Rows2 /></button>
              <button type="button" className="icon-button" title={[t("Maximize / restore focused view"), zoomKeys].filter(Boolean).join(" · ")} aria-label={t("Zoom pane")} aria-pressed={layout.zoomed} onClick={() => onAction({ type: "zoom" }, cell.paneId)}><Maximize2 /></button>
              <button type="button" className="icon-button" title={t("Close view only — keep the session running")} aria-label={t("Close view only — keep the session running")} onClick={() => onAction({ type: "close" }, cell.paneId)}><X /></button>
            </header>
            <div className="split-cell-body">{renderPane(cell.paneId, active)}</div>
            {active && error && <div className="split-cell-error" role="alert">{error}</div>}
          </section>
        );
      })}
      {dividers(shown).map((divider) => {
        const dragging = preview?.dragging === true && preview.splitId === divider.splitId;
        const style = divider.orientation === "vertical"
          ? { left: pct(divider.position), top: pct(divider.start), height: pct(divider.length) }
          : { top: pct(divider.position), left: pct(divider.start), width: pct(divider.length) };
        return (
          <div
            key={divider.splitId}
            className={`split-divider is-${divider.orientation}${dragging ? " is-dragging" : ""}`}
            style={style}
            role="separator"
            tabIndex={0}
            aria-label={t("Resize split view")}
            aria-orientation={divider.orientation}
            aria-valuenow={Math.round(divider.ratio * 100)}
            aria-valuemin={10}
            aria-valuemax={90}
            onKeyDown={(event) => {
              const keys = divider.orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
              const index = keys.indexOf(event.key);
              if (index < 0 && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault(); event.stopPropagation();
              onResize(divider.splitId, event.key === "Home" ? 0.1 : event.key === "End" ? 0.9 : divider.ratio + (index === 0 ? -0.05 : 0.05));
            }}
            onPointerDown={startDrag(divider)}
          />
        );
      })}
    </div>
  );
}
