import type { PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import type { PaneView } from "./actions.ts";

export type Direction = "left" | "right" | "up" | "down";

/** What a split cell's buttons ask App to do to a pane. */
export type SplitAction =
  | { type: "focus"; direction: Direction }
  | { type: "split"; direction: "right" | "down" }
  | { type: "zoom" }
  | { type: "close" };
/** Percentages of the tab's area. */
export interface Box { left: number; top: number; width: number; height: number }
export interface Cell { paneId: string; box: Box; focused: boolean }
/** Number visible views by column, then downward within the column; never mutate render order. */
export function screenOrder<T extends { readonly box: Pick<Box, "left" | "top"> }>(views: readonly T[]): T[] {
  return [...views].sort((a, b) => a.box.left - b.box.left || a.box.top - b.box.top);
}
/** A split's boundary: vertical lines come from right splits, horizontal ones from down splits. */
export interface Divider {
  splitId: string;
  orientation: "vertical" | "horizontal";
  /** left% for a vertical line, top% for a horizontal one */
  position: number;
  /** top% (vertical) or left% (horizontal) where the line starts */
  start: number;
  length: number;
  ratio: number;
  direction: "right" | "down";
}

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
/** herdr rounds rects to whole cells: edges within a cell count as touching. */
const EDGE_SLACK = 1;

const round = (value: number): number => Math.round(value * 1000) / 1000;

function validRect(rect: PaneLayoutRect, area: PaneLayoutRect): boolean {
  return rect.width > 0 && rect.height > 0
    && rect.x >= area.x && rect.y >= area.y
    && rect.x + rect.width <= area.x + area.width
    && rect.y + rect.height <= area.y + area.height;
}

/** The tab layout holding the pane, when it has several panes and sane geometry; null otherwise. */
export function layoutForPane(
  snapshot: { layouts?: PaneLayoutSnapshot[] } | null | undefined,
  paneId: string | null,
): PaneLayoutSnapshot | null {
  if (!snapshot?.layouts || paneId === null) return null;
  const layout = snapshot.layouts.find((entry) => entry.panes.some((pane) => pane.pane_id === paneId));
  if (!layout || layout.panes.length < 2) return null;
  if (layout.area.width <= 0 || layout.area.height <= 0) return null;
  if (!layout.panes.every((pane) => validRect(pane.rect, layout.area))) return null;
  return layout;
}

function toBox(rect: PaneLayoutRect, area: PaneLayoutRect): Box {
  return {
    left: round(((rect.x - area.x) / area.width) * 100),
    top: round(((rect.y - area.y) / area.height) * 100),
    width: round((rect.width / area.width) * 100),
    height: round((rect.height / area.height) * 100),
  };
}

/**
 * The cells to draw. A zoomed tab shows one pane full size: the active one (picked in the sidebar,
 * say) when the tab holds it, else herdr's focused pane; none when the tab holds neither, and the
 * caller falls back to the single view.
 */
export function cells(layout: PaneLayoutSnapshot, activePaneId?: string | null): Cell[] {
  if (layout.zoomed) {
    const holds = (id: string | null | undefined): id is string => !!id && layout.panes.some((pane) => pane.pane_id === id);
    const shown = holds(activePaneId) ? activePaneId : holds(layout.focused_pane_id) ? layout.focused_pane_id : null;
    if (shown === null) return [];
    return [{ paneId: shown, focused: shown === layout.focused_pane_id, box: { left: 0, top: 0, width: 100, height: 100 } }];
  }
  return layout.panes.map((pane) => ({ paneId: pane.pane_id, focused: pane.focused, box: toBox(pane.rect, layout.area) }));
}

export function dividers(layout: PaneLayoutSnapshot): Divider[] {
  if (layout.zoomed) return [];
  const { area } = layout;
  return layout.splits.map((split) => {
    const box = toBox(split.rect, area);
    if (split.direction === "right") {
      return {
        splitId: split.id, orientation: "vertical", direction: "right", ratio: split.ratio,
        position: round(box.left + split.ratio * box.width), start: box.top, length: box.height,
      };
    }
    return {
      splitId: split.id, orientation: "horizontal", direction: "down", ratio: split.ratio,
      position: round(box.top + split.ratio * box.height), start: box.left, length: box.width,
    };
  });
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

/** The pane across the given edge with the longest shared border (ties: the topmost/leftmost). */
export function neighbor(layout: PaneLayoutSnapshot, paneId: string, direction: Direction): string | null {
  if (layout.zoomed) return null;
  const from = layout.panes.find((pane) => pane.pane_id === paneId)?.rect;
  if (!from) return null;
  let best: { id: string; shared: number; order: number } | null = null;
  for (const pane of layout.panes) {
    if (pane.pane_id === paneId) continue;
    const to = pane.rect;
    let touches: boolean;
    let shared: number;
    let order: number;
    if (direction === "right" || direction === "left") {
      touches = direction === "right"
        ? Math.abs(to.x - (from.x + from.width)) <= EDGE_SLACK
        : Math.abs(to.x + to.width - from.x) <= EDGE_SLACK;
      shared = overlap(from.y, from.y + from.height, to.y, to.y + to.height);
      order = to.y;
    } else {
      touches = direction === "down"
        ? Math.abs(to.y - (from.y + from.height)) <= EDGE_SLACK
        : Math.abs(to.y + to.height - from.y) <= EDGE_SLACK;
      shared = overlap(from.x, from.x + from.width, to.x, to.x + to.width);
      order = to.x;
    }
    if (!touches || shared <= 0) continue;
    if (!best || shared > best.shared || (shared === best.shared && order < best.order)) {
      best = { id: pane.pane_id, shared, order };
    }
  }
  return best?.id ?? null;
}

/** The pane to select once `paneId` closes: a neighbor (left, up, right, down), else any other pane of the tab. */
export function replacementAfterClose(layout: PaneLayoutSnapshot, paneId: string): string | null {
  if (!layout.panes.some((pane) => pane.pane_id === paneId)) return null;
  for (const direction of ["left", "up", "right", "down"] as const) {
    const next = neighbor(layout, paneId, direction);
    if (next !== null) return next;
  }
  return layout.panes.find((pane) => pane.pane_id !== paneId)?.pane_id ?? null;
}

/** Converts a pointer position (fraction of the container on the split's axis) into that split's ratio. */
export function ratioFromPointer(layout: PaneLayoutSnapshot, splitId: string, fraction: number): number {
  const split = layout.splits.find((entry) => entry.id === splitId);
  if (!split) return 0.5;
  const { area, rect } = split.direction === "right"
    ? { area: { start: layout.area.x, size: layout.area.width }, rect: { start: split.rect.x, size: split.rect.width } }
    : { area: { start: layout.area.y, size: layout.area.height }, rect: { start: split.rect.y, size: split.rect.height } };
  const cell = area.start + fraction * area.size;
  return (cell - rect.start) / rect.size;
}

/**
 * The layout with one split's ratio changed (clamped to 0.1..0.9), as herdr would draw it: along
 * the split's axis, everything inside its rect stretches on each side of the moved boundary.
 * Drives the live preview while a boundary is dragged, before herdr answers with the real one.
 */
export function withSplitRatio(layout: PaneLayoutSnapshot, splitId: string, ratio: number): PaneLayoutSnapshot {
  const split = layout.splits.find((entry) => entry.id === splitId);
  if (!split) return layout;
  const target = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const vertical = split.direction === "right";
  const start = vertical ? split.rect.x : split.rect.y;
  const size = vertical ? split.rect.width : split.rect.height;
  const across0 = vertical ? split.rect.y : split.rect.x;
  const across1 = across0 + (vertical ? split.rect.height : split.rect.width);
  const from = start + split.ratio * size;
  const to = start + target * size;
  const end = start + size;
  // piecewise-linear: [start, from] → [start, to], [from, end] → [to, end]
  const map = (c: number): number => c <= from
    ? start + ((c - start) * (to - start)) / (from - start)
    : to + ((c - from) * (end - to)) / (end - from);
  const remap = (rect: PaneLayoutRect): PaneLayoutRect => {
    const a0 = vertical ? rect.y : rect.x;
    const a1 = a0 + (vertical ? rect.height : rect.width);
    const c0 = vertical ? rect.x : rect.y;
    const c1 = c0 + (vertical ? rect.width : rect.height);
    if (a0 < across0 || a1 > across1 || c0 < start || c1 > end) return rect;
    const n0 = round(map(c0));
    const n1 = round(map(c1));
    return vertical ? { ...rect, x: n0, width: round(n1 - n0) } : { ...rect, y: n0, height: round(n1 - n0) };
  };
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({ ...pane, rect: remap(pane.rect) })),
    splits: layout.splits.map((entry) => entry.id === splitId ? { ...entry, ratio: target } : { ...entry, rect: remap(entry.rect) }),
  };
}

/**
 * The pane.resize call that moves a split's boundary to `nextRatio`: herdr's amount is the
 * ratio delta, right/down grow it and left/up shrink it, clamped to 0.1..0.9 (measured).
 * The pane sent is the one in front of the boundary (left of a vertical, above a horizontal).
 */
export function resizeForDrag(
  layout: PaneLayoutSnapshot,
  splitId: string,
  nextRatio: number,
): { paneId: string; direction: Direction; amount: number } | null {
  const split = layout.splits.find((entry) => entry.id === splitId);
  if (!split) return null;
  const target = Math.min(MAX_RATIO, Math.max(MIN_RATIO, nextRatio));
  const delta = round(target - split.ratio);
  if (Math.abs(delta) < 0.005) return null;
  const vertical = split.direction === "right";
  const boundary = vertical
    ? split.rect.x + split.ratio * split.rect.width
    : split.rect.y + split.ratio * split.rect.height;
  const leading = layout.panes.find((pane) => {
    const r = pane.rect;
    const inside = vertical
      ? r.x >= split.rect.x && r.y >= split.rect.y && r.y + r.height <= split.rect.y + split.rect.height
      : r.y >= split.rect.y && r.x >= split.rect.x && r.x + r.width <= split.rect.x + split.rect.width;
    const edge = vertical ? r.x + r.width : r.y + r.height;
    return inside && Math.abs(edge - boundary) <= EDGE_SLACK;
  });
  if (!leading) return null;
  const direction: Direction = vertical ? (delta > 0 ? "right" : "left") : (delta > 0 ? "down" : "up");
  return { paneId: leading.pane_id, direction, amount: Math.abs(delta) };
}

/**
 * The lens a split cell shows: the active cell the one App holds (the header toggle and ⌘⇧J switch
 * it, and store it), every other cell its own pane's remembered one, so a pane switched to chat is
 * still chat once another pane is active.
 */
export function cellView(paneId: string, activePaneId: string | null, activeView: PaneView, stored: (paneId: string) => PaneView): PaneView {
  return paneId === activePaneId ? activeView : stored(paneId);
}
