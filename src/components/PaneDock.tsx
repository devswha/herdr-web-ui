import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, GripVertical, Maximize2, MessageSquare, PanelsTopLeft, SquareTerminal, X } from "lucide-react";
import type { PaneTarget } from "../../shared/machines.ts";
import type { PaneView } from "../lib/actions.ts";
import { dockCells, dockDividers, dockTargetKey, dockTargets, type DockNode } from "../lib/dock-layout.ts";
import { type Box, type Direction, type Divider } from "../lib/split-layout.ts";
import { PANE_DRAG_TYPE, readPaneDrag, startPaneDrag, usePaneDock } from "../lib/paneDock.ts";
import { useT } from "../lib/i18n.ts";
import "./PaneDock.css";
import { sessionStyle } from "../lib/session-identity.ts";
import { SessionBadge } from "./SessionBadge.tsx";
import type { LayoutPreset } from "../lib/running-layout.ts";
import { formatKeys, shortcutDisplayKeys } from "../lib/shortcuts.ts";
import { useSettings } from "../lib/settings.ts";

interface Props {
  readonly root: DockNode | null;
  readonly seed: DockNode | null;
  readonly active: PaneTarget | null;
  readonly desktop: boolean;
  readonly zoomed: string | null;
  readonly placement: PaneTarget | null;
  readonly dragging: PaneTarget | null;
  readonly native: ReactNode;
  readonly label: (target: PaneTarget) => string;
  readonly view: (target: PaneTarget) => PaneView;
  readonly renderPane: (target: PaneTarget, active: boolean) => ReactNode;
  readonly onActivate: (target: PaneTarget) => void;
  readonly onView: (target: PaneTarget, view: PaneView) => void;
  readonly onPlace: (source: PaneTarget, anchor: string | null, direction: Direction) => void;
  readonly onRemove: (target: PaneTarget) => void;
  readonly onZoom: (target: PaneTarget) => void;
  readonly onResize: (id: string, ratio: number) => void;
  readonly onLayout: (preset: LayoutPreset) => void;
  readonly onCancel: () => void;
  readonly onExit: () => void;
}

interface Destination { readonly key: string; readonly direction: Direction; readonly box: Box }
const full: Box = { left: 0, top: 0, width: 100, height: 100 };
const edges = ["left", "up", "down", "right"] as const;
const icons = { left: ArrowLeft, right: ArrowRight, up: ArrowUp, down: ArrowDown };
const boxStyle = (box: Box): CSSProperties => ({ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });

function half(box: Box, direction: Direction): Box {
  if (direction === "left") return { ...box, width: box.width / 2 };
  if (direction === "right") return { ...box, left: box.left + box.width / 2, width: box.width / 2 };
  if (direction === "up") return { ...box, height: box.height / 2 };
  return { ...box, top: box.top + box.height / 2, height: box.height / 2 };
}

/** Flat, identity-keyed cells keep their terminals mounted while the binary tree is rearranged. */
export function PaneDock(props: Props) {
  const t = useT();
  const { settings } = useSettings();
  const zoomKeys = formatKeys(shortcutDisplayKeys("zoom-view", settings.shortcutOverrides)).join("");
  const labels = { left: t("Place on the left"), right: t("Place on the right"), up: t("Place above"), down: t("Place below") };
  const drag = usePaneDock();
  const host = useRef<HTMLDivElement>(null);
  const placementDialog = useRef<HTMLDialogElement>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  const cancelPlacement = () => {
    // Release the native modal's inert background before App restores its opener's focus.
    placementDialog.current?.close();
    props.onCancel();
  };
  const activeKey = props.active ? dockTargetKey(props.active) : null;
  const tree = props.root ?? props.seed;
  const all = dockCells(tree);
  const selected = all.find((cell) => dockTargetKey(cell.target) === (props.zoomed ?? activeKey)) ?? all[0];
  const shown = (props.zoomed !== null || !props.desktop) && selected ? [{ ...selected, box: full }] : all;
  const placement = props.placement;
  const presets: { id: LayoutPreset; label: string; columns: number; rows: number }[] = [
    { id: "auto", label: t("Auto layout"), columns: 4, rows: 1 },
    { id: "2-columns", label: t("2 columns"), columns: 2, rows: 1 },
    { id: "3-columns", label: t("3 columns"), columns: 3, rows: 1 },
    { id: "4-columns", label: t("4 columns"), columns: 4, rows: 1 },
    { id: "2x2", label: t("2 × 2"), columns: 2, rows: 2 },
    { id: "3x2", label: t("3 × 2"), columns: 3, rows: 2 },
  ];

  useEffect(() => {
    if (!props.dragging) setDestination(null);
  }, [props.dragging]);
  useEffect(() => {
    const dialog = placementDialog.current;
    if (placement && dialog) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>("[data-dock-side]")?.focus();
    }
    return () => dialog?.close();
  }, [placement]);
  useEffect(() => {
    const stop = () => setDestination(null);
    window.addEventListener("dragend", stop);
    return () => window.removeEventListener("dragend", stop);
  }, []);

  const locate = (event: DragEvent): Destination | null => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return null;
    const x = (event.clientX - rect.left) / rect.width * 100;
    const y = (event.clientY - rect.top) / rect.height * 100;
    const cell = shown.find(({ box }) => x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height);
    if (!cell) return null;
    const rx = (x - cell.box.left) / cell.box.width;
    const ry = (y - cell.box.top) / cell.box.height;
    // Every point is a split destination; ties in the middle choose the right side.
    const distances: { direction: Direction; distance: number }[] = [
      { direction: "right", distance: 1 - rx }, { direction: "left", distance: rx },
      { direction: "up", distance: ry }, { direction: "down", distance: 1 - ry },
    ];
    const nearest = distances.reduce((best, next) => next.distance < best.distance ? next : best);
    return { key: dockTargetKey(cell.target), direction: nearest.direction, box: cell.box };
  };
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(PANE_DRAG_TYPE);
  const over = (event: DragEvent<HTMLDivElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDestination(locate(event));
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const source = readPaneDrag(event.dataTransfer);
    const next = locate(event);
    setDestination(null);
    drag?.endDrag();
    if (source) props.onPlace(source, next?.key ?? null, next?.direction ?? "right");
  };

  const resize = (event: PointerEvent<HTMLDivElement>, divider: Divider) => {
    const rect = host.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const vertical = divider.orientation === "vertical";
    const start = vertical ? event.clientX : event.clientY;
    const area = vertical ? rect.width : rect.height;
    const splitBox = (node: DockNode | null, box: Box): Box | null => {
      if (!node || node.kind === "pane") return null;
      if (node.id === divider.splitId) return box;
      const row = node.direction === "right";
      const leading = (row ? box.width : box.height) * node.ratio;
      return splitBox(node.first, row ? { ...box, width: leading } : { ...box, height: leading })
        ?? splitBox(node.second, row ? { ...box, left: box.left + leading, width: box.width - leading }
          : { ...box, top: box.top + leading, height: box.height - leading });
    };
    const bounds = splitBox(props.root, full);
    if (!bounds) return;
    const span = area * (vertical ? bounds.width : bounds.height) / 100;
    if (!(span > 0)) return;
    const node = event.currentTarget;
    const move = (next: globalThis.PointerEvent) => props.onResize(divider.splitId, divider.ratio + ((vertical ? next.clientX : next.clientY) - start) / span);
    const end = () => {
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", end);
      node.removeEventListener("pointercancel", end);
      node.removeEventListener("lostpointercapture", end);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("lostpointercapture", end);
  };

  return <div className="pane-dock">
    {(props.root || all.length > 1) && <div className="dock-toolbar">
      {!props.desktop ? <nav className="dock-tabs" aria-label={t("Split views")}>
        {dockTargets(props.root).map((target) => <button type="button" key={dockTargetKey(target)} style={sessionStyle(drag?.viewNumbers?.get(dockTargetKey(target)))} aria-current={dockTargetKey(target) === activeKey ? "page" : undefined} onClick={() => props.onActivate(target)}><SessionBadge number={drag?.viewNumbers?.get(dockTargetKey(target))} /> {props.label(target)}</button>)}
      </nav> : <span className="dock-toolbar-label">{t("Split views")} · {all.length}</span>}
      <div className="dock-layout-presets" role="group" aria-label={t("Layout presets")}>
        {presets.map((preset) => <button type="button" key={preset.id} data-layout-preset={preset.id}
          disabled={all.length < 2} aria-label={t("Arrange views: {layout}", { layout: preset.label })}
          title={t("Arrange views: {layout}", { layout: preset.label })} onClick={() => props.onLayout(preset.id)}>
          {preset.id === "auto" ? <span>{preset.label}</span> : <span className="dock-layout-preview" aria-hidden="true"
            style={{ gridTemplateColumns: `repeat(${preset.columns}, 1fr)`, gridTemplateRows: `repeat(${preset.rows}, 1fr)` }}>
            {Array.from({ length: preset.columns * preset.rows }, (_, index) => <span key={index} />)}
          </span>}
        </button>)}
      </div>
      {props.root && <button type="button" className="dock-exit" title={t("Return to the workspace layout")} aria-label={t("Return to the workspace layout")} onClick={props.onExit}><PanelsTopLeft aria-hidden="true" /></button>}
    </div>}
    <div className="dock-stage" ref={host} onDragOverCapture={over} onDropCapture={drop}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDestination(null); }}
      onKeyDownCapture={(event) => {
        if (!placement) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelPlacement(); return; }
        if (event.key !== "Tab") return;
        const buttons = [...(host.current?.querySelectorAll<HTMLButtonElement>(".dock-placement button:not(:disabled)") ?? [])];
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      {props.root === null ? props.native : all.map(({ target, box: originalBox }) => {
        const key = dockTargetKey(target);
        const visible = shown.find((cell) => dockTargetKey(cell.target) === key);
        const box = visible?.box ?? originalBox;
        const active = key === activeKey && visible !== undefined;
        const viewNumber = drag?.viewNumbers?.get(key);
        return <section className={`dock-cell${active ? " is-active" : ""}`} data-dock-key={key} data-pane-id={target.pane_id} data-machine-id={target.machine_id}
          data-session-number={viewNumber} style={{ ...boxStyle(box), ...sessionStyle(viewNumber), visibility: visible ? undefined : "hidden" }} key={key} aria-label={props.label(target)}
          {...(!visible ? { inert: "" } : {})}
          onPointerDownCapture={() => { if (!active) props.onActivate(target); }}
          onFocusCapture={() => { if (!active) props.onActivate(target); }}>
          <header className="dock-cell-head">
            <span className="dock-cell-title" draggable title={`${props.label(target)} — ${t("Drag to rearrange this view")}`}
              onDragStart={(event) => startPaneDrag(event, target, drag)} onDragEnd={() => drag?.endDrag()}>
              <GripVertical aria-hidden="true" /><SessionBadge number={viewNumber} /><span>{props.label(target)}</span>
            </span>
            <div className="dock-cell-view" role="group" aria-label={t("Pane view")}>
              <button type="button" aria-pressed={props.view(target) === "chat"} title={t("Chat")} aria-label={t("Chat")} onClick={() => props.onView(target, "chat")}><MessageSquare aria-hidden="true" /></button>
              <button type="button" aria-pressed={props.view(target) === "terminal"} title={t("Terminal")} aria-label={t("Terminal")} onClick={() => props.onView(target, "terminal")}><SquareTerminal aria-hidden="true" /></button>
            </div>
            <button type="button" className="dock-place-button" title={t("Place in split view")} aria-label={t("Place in split view")} onClick={() => drag?.place(target)}><PanelsTopLeft aria-hidden="true" /></button>
            <button type="button" title={[t("Maximize / restore focused view"), zoomKeys].filter(Boolean).join(" · ")} aria-label={t("Maximize this view")} aria-pressed={props.zoomed === key} onClick={() => props.onZoom(target)}><Maximize2 aria-hidden="true" /></button>
            <button type="button" title={t("Close view only — keep the session running")} aria-label={t("Close view only — keep the session running")} onClick={() => props.onRemove(target)}><X aria-hidden="true" /></button>
          </header>
          <div className="dock-cell-body">{props.renderPane(target, active)}</div>
        </section>;
      })}
      {props.root && props.desktop && props.zoomed === null && dockDividers(props.root).map((divider) => <div
        key={divider.splitId} className={`dock-divider is-${divider.orientation}`} role="separator" tabIndex={0}
        aria-label={t("Resize split view")} aria-orientation={divider.orientation} aria-valuenow={Math.round(divider.ratio * 100)} aria-valuemin={10} aria-valuemax={90}
        style={divider.orientation === "vertical" ? { left: `${divider.position}%`, top: `${divider.start}%`, height: `${divider.length}%` } : { top: `${divider.position}%`, left: `${divider.start}%`, width: `${divider.length}%` }}
        onPointerDown={(event) => resize(event, divider)}
        onKeyDown={(event) => {
          const direction = divider.orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
          const index = direction.indexOf(event.key);
          if (event.key === "Home" || event.key === "End") {
            event.preventDefault(); event.stopPropagation();
            props.onResize(divider.splitId, event.key === "Home" ? 0.1 : 0.9);
            return;
          }
          if (index < 0) return;
          event.preventDefault(); event.stopPropagation();
          props.onResize(divider.splitId, divider.ratio + (index === 0 ? -0.05 : 0.05));
        }} />)}
      {destination && props.dragging && <div className="dock-drop-preview" style={boxStyle(half(destination.box, destination.direction))} aria-hidden="true">
        <span>{labels[destination.direction]}</span>
      </div>}
      {placement && <dialog ref={placementDialog} className="dock-placement" aria-label={t("Choose where to place this view")}
        onCancel={(event) => { event.preventDefault(); cancelPlacement(); }}>
        <div className="dock-placement-heading"><span>{t("Choose where to place this view")}</span><button type="button" aria-label={t("Cancel placement")} title={t("Cancel placement")} onClick={cancelPlacement}><X aria-hidden="true" /></button></div>
        {(shown.length ? shown : [{ target: placement, box: full }]).map(({ target, box }) => <div className="dock-placement-cell" key={dockTargetKey(target)} style={boxStyle(box)}>
          <div className="dock-placement-buttons">{edges.map((edge) => {
            const Icon = icons[edge];
            return <button type="button" data-dock-side={edge} key={edge} className={`is-${edge}`} title={labels[edge]} aria-label={`${labels[edge]}: ${props.label(target)}`}
              onClick={() => props.onPlace(placement, shown.length ? dockTargetKey(target) : null, edge)}><Icon aria-hidden="true" /></button>;
          })}</div>
        </div>)}
      </dialog>}
    </div>
  </div>;
}
