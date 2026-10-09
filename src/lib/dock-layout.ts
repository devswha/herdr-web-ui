import type { PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/herdr-api.generated.ts";
import { paneStorageId, type PaneTarget } from "../../shared/machines.ts";
import type { Box, Direction, Divider } from "./split-layout.ts";

export type DockNode =
  | { readonly kind: "pane"; readonly target: PaneTarget }
  | {
    readonly kind: "split";
    readonly id: string;
    readonly direction: "right" | "down";
    readonly ratio: number;
    readonly first: DockNode;
    readonly second: DockNode;
  };

export function dockTargetKey(target: PaneTarget): string {
  return paneStorageId(target.machine_id, target.pane_id);
}

export function dockTargets(root: DockNode | null): PaneTarget[] {
  if (root === null) return [];
  switch (root.kind) {
    case "pane": return [root.target];
    case "split": return [...dockTargets(root.first), ...dockTargets(root.second)];
  }
}

/** Rebuild only changed branches and collapse a split when either child disappears. */
function editPanes(root: DockNode | null, edit: (pane: Extract<DockNode, { kind: "pane" }>) => DockNode | null): DockNode | null {
  if (root === null) return null;
  switch (root.kind) {
    case "pane": return edit(root);
    case "split": {
      const first = editPanes(root.first, edit);
      const second = editPanes(root.second, edit);
      if (first === null) return second;
      if (second === null) return first;
      return first === root.first && second === root.second ? root : { ...root, first, second };
    }
  }
}

export function removeDockPane(root: DockNode | null, key: string): DockNode | null {
  return editPanes(root, (pane) => dockTargetKey(pane.target) === key ? null : pane);
}

export function pruneDock(root: DockNode | null, keep: (target: PaneTarget) => boolean): DockNode | null {
  return editPanes(root, (pane) => keep(pane.target) ? pane : null);
}

export function replaceDockPane(root: DockNode | null, key: string, target: PaneTarget): DockNode | null {
  if (dockTargets(root).some((pane) => dockTargetKey(pane) === dockTargetKey(target))) return root;
  return editPanes(root, (pane) => dockTargetKey(pane.target) === key ? { kind: "pane", target } : pane);
}

/**
 * A null anchor splits the whole remaining tree. An unknown nonnull anchor preserves the
 * original tree, including a source already docked there. IDs belong to the caller.
 */
export function dockPane(
  root: DockNode | null, target: PaneTarget, anchorKey: string | null, edge: Direction, splitId: string,
): DockNode {
  const pane: DockNode = { kind: "pane", target };
  if (root === null) return pane;
  const key = dockTargetKey(target);
  if (anchorKey === key || (anchorKey !== null && !dockTargets(root).some((entry) => dockTargetKey(entry) === anchorKey))) return root;
  const remaining = removeDockPane(root, key);
  if (remaining === null) return root;
  const beside = (anchor: DockNode): DockNode => ({
    kind: "split", id: splitId, direction: edge === "left" || edge === "right" ? "right" : "down", ratio: 0.5,
    first: edge === "left" || edge === "up" ? pane : anchor,
    second: edge === "left" || edge === "up" ? anchor : pane,
  });
  if (anchorKey === null) return beside(remaining);
  return editPanes(remaining, (entry) => dockTargetKey(entry.target) === anchorKey ? beside(entry) : entry) ?? root;
}

export function resizeDockSplit(root: DockNode | null, id: string, ratio: number): DockNode | null {
  if (root === null || Number.isNaN(ratio)) return root;
  switch (root.kind) {
    case "pane": return root;
    case "split": {
      const next = Math.min(0.9, Math.max(0.1, ratio));
      if (root.id === id) return next === root.ratio ? root : { ...root, ratio: next };
      const first = resizeDockSplit(root.first, id, ratio);
      const second = resizeDockSplit(root.second, id, ratio);
      if (first === null || second === null) return root;
      return first === root.first && second === root.second ? root : { ...root, first, second };
    }
  }
}

export function swapDockPanes(root: DockNode | null, a: string, b: string): DockNode | null {
  const targets = dockTargets(root);
  const first = targets.find((pane) => dockTargetKey(pane) === a);
  const second = targets.find((pane) => dockTargetKey(pane) === b);
  if (!first || !second || a === b) return root;
  return editPanes(root, (pane) => {
    const key = dockTargetKey(pane.target);
    return key === a ? { kind: "pane", target: second } : key === b ? { kind: "pane", target: first } : pane;
  });
}

/** Grow toward an edge using the nearest enclosing divider with space on that side. */
export function resizeDockPane(root: DockNode | null, key: string, direction: Direction, amount = 0.05): DockNode | null {
  if (root === null || !Number.isFinite(amount) || amount <= 0) return root;
  const axis = direction === "left" || direction === "right" ? "right" : "down";
  const towardSecond = direction === "right" || direction === "down";
  const find = (node: DockNode): { id: string; ratio: number } | null => {
    switch (node.kind) {
      case "pane": return null;
      case "split": {
        const inFirst = dockTargets(node.first).some((target) => dockTargetKey(target) === key);
        const inSecond = !inFirst && dockTargets(node.second).some((target) => dockTargetKey(target) === key);
        if (!inFirst && !inSecond) return null;
        const deeper = find(inFirst ? node.first : node.second);
        if (deeper) return deeper;
        return node.direction === axis && inFirst === towardSecond
          ? { id: node.id, ratio: node.ratio + (inFirst ? amount : -amount) } : null;
      }
    }
  };
  const split = find(root);
  return split ? resizeDockSplit(root, split.id, split.ratio) : root;
}

function geometry(root: DockNode | null): { cells: { target: PaneTarget; box: Box }[]; dividers: Divider[] } {
  // Local accumulators; tree and caller-owned targets are never mutated.
  const cells: { target: PaneTarget; box: Box }[] = [];
  const dividers: Divider[] = [];
  const visit = (node: DockNode, box: Box): void => {
    switch (node.kind) {
      case "pane": cells.push({ target: node.target, box }); return;
      case "split": {
        const vertical = node.direction === "right";
        const size = vertical ? box.width : box.height;
        const leading = size * node.ratio;
        const position = (vertical ? box.left : box.top) + leading;
        dividers.push({
          splitId: node.id, direction: node.direction, ratio: node.ratio,
          orientation: vertical ? "vertical" : "horizontal",
          position, start: vertical ? box.top : box.left, length: vertical ? box.height : box.width,
        });
        visit(node.first, vertical ? { ...box, width: leading } : { ...box, height: leading });
        visit(node.second, vertical
          ? { ...box, left: position, width: size - leading }
          : { ...box, top: position, height: size - leading });
      }
    }
  };
  if (root !== null) visit(root, { left: 0, top: 0, width: 100, height: 100 });
  return { cells, dividers };
}

export function dockCells(root: DockNode | null): { target: PaneTarget; box: Box }[] {
  return geometry(root).cells;
}

export function dockDividers(root: DockNode | null): Divider[] {
  return geometry(root).dividers;
}

/** Redistribute space after an insertion so existing roomy siblings do not starve new views. */
export function fitDockLayout(root: DockNode | null, width: number, height: number, minimumWidth: number, minimumHeight: number): DockNode | null {
  if (!root || ![width, height, minimumWidth, minimumHeight].every((value) => Number.isFinite(value) && value > 0)) return root;
  const minimum = (node: DockNode): { width: number; height: number } => {
    if (node.kind === "pane") return { width: minimumWidth, height: minimumHeight };
    const a = minimum(node.first), b = minimum(node.second);
    return node.direction === "right" ? { width: a.width + b.width, height: Math.max(a.height, b.height) }
      : { width: Math.max(a.width, b.width), height: a.height + b.height };
  };
  const fit = (node: DockNode, w: number, h: number): DockNode => {
    if (node.kind === "pane") return node;
    const row = node.direction === "right";
    const a = minimum(node.first), b = minimum(node.second);
    const leading = row ? a.width : a.height, trailing = row ? b.width : b.height;
    const total = row ? w : h;
    const wanted = leading + trailing <= total
      ? Math.min(1 - trailing / total, Math.max(leading / total, node.ratio))
      : leading / (leading + trailing);
    const ratio = Math.min(0.9, Math.max(0.1, wanted));
    const first = fit(node.first, row ? w * ratio : w, row ? h : h * ratio);
    const second = fit(node.second, row ? w * (1 - ratio) : w, row ? h : h * (1 - ratio));
    return ratio === node.ratio && first === node.first && second === node.second ? node : { ...node, ratio, first, second };
  };
  return fit(root, width, height);
}

/** Longest shared edge wins; ties prefer the topmost/leftmost cell. */
export function dockNeighbor(root: DockNode | null, key: string, direction: Direction): PaneTarget | null {
  const cells = dockCells(root);
  const from = cells.find((cell) => dockTargetKey(cell.target) === key)?.box;
  if (!from) return null;
  let best: { target: PaneTarget; shared: number; order: number } | null = null;
  for (const cell of cells) {
    if (dockTargetKey(cell.target) === key) continue;
    const to = cell.box;
    const vertical = direction === "left" || direction === "right";
    const gap = direction === "right" ? to.left - from.left - from.width
      : direction === "left" ? to.left + to.width - from.left
      : direction === "down" ? to.top - from.top - from.height : to.top + to.height - from.top;
    const shared = vertical
      ? Math.min(from.top + from.height, to.top + to.height) - Math.max(from.top, to.top)
      : Math.min(from.left + from.width, to.left + to.width) - Math.max(from.left, to.left);
    const order = vertical ? to.top : to.left;
    if (Math.abs(gap) > 1e-7 || shared <= 1e-7) continue;
    if (best === null || shared > best.shared + 1e-7 || (Math.abs(shared - best.shared) <= 1e-7 && order < best.order)) {
      best = { target: cell.target, shared, order };
    }
  }
  return best?.target ?? null;
}

/** Persisted data is all-or-nothing, bounded to 64 levels and 4095 nodes. */
export function parseDockLayout(value: unknown): DockNode | null {
  const seen = new Set<object>();
  const targets = new Set<string>();
  const ids = new Set<string>();
  const record = (input: unknown): input is Record<string, unknown> => typeof input === "object" && input !== null && !Array.isArray(input);
  const identity = (input: unknown): input is string => typeof input === "string" && input.trim().length > 0;
  const parse = (input: unknown, depth: number): DockNode | null => {
    if (!record(input) || depth > 64 || seen.size >= 4095 || seen.has(input)) return null;
    seen.add(input);
    switch (input.kind) {
      case "pane": {
        const target = input.target;
        if (!record(target) || !identity(target.machine_id) || !identity(target.pane_id)) return null;
        const result: PaneTarget = { machine_id: target.machine_id, pane_id: target.pane_id };
        const key = dockTargetKey(result);
        if (targets.has(key)) return null;
        targets.add(key);
        return { kind: "pane", target: result };
      }
      case "split": {
        if (!identity(input.id) || ids.has(input.id) || (input.direction !== "right" && input.direction !== "down")
          || typeof input.ratio !== "number" || !Number.isFinite(input.ratio) || input.ratio < 0.1 || input.ratio > 0.9) return null;
        ids.add(input.id);
        const first = parse(input.first, depth + 1);
        const second = parse(input.second, depth + 1);
        return first === null || second === null ? null : {
          kind: "split", id: input.id, direction: input.direction, ratio: input.ratio, first, second,
        };
      }
      default: return null;
    }
  };
  return parse(value, 0);
}

/** Reconstruct native hierarchy by each split's enclosing rectangle, independent of array order. */
export function dockFromNative(layout: PaneLayoutSnapshot, machineId: string, activePaneId: string | null): DockNode | null {
  const pane = (id: string): DockNode => ({ kind: "pane", target: { machine_id: machineId, pane_id: id } });
  if (layout.zoomed) {
    const visible = layout.panes.find((entry) => entry.pane_id === activePaneId)
      ?? layout.panes.find((entry) => entry.pane_id === layout.focused_pane_id);
    return visible ? parseDockLayout(pane(visible.pane_id)) : null;
  }
  const sane = (rect: PaneLayoutRect): boolean => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
  if (!sane(layout.area) || !layout.panes.every((entry) => sane(entry.rect)
    && entry.rect.x >= layout.area.x && entry.rect.y >= layout.area.y
    && entry.rect.x + entry.rect.width <= layout.area.x + layout.area.width
    && entry.rect.y + entry.rect.height <= layout.area.y + layout.area.height)) return null;
  const same = (a: PaneLayoutRect, b: PaneLayoutRect): boolean =>
    Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
    && Math.abs(a.x + a.width - b.x - b.width) <= 1 && Math.abs(a.y + a.height - b.y - b.height) <= 1;
  const build = (panes: PaneLayoutSnapshot["panes"], region: PaneLayoutRect, depth: number): DockNode | null => {
    if (depth > 64 || panes.length === 0) return null;
    const only = panes[0];
    if (panes.length === 1 && only) return same(only.rect, region) ? pane(only.pane_id) : null;
    const split = layout.splits.find((entry) => sane(entry.rect) && same(entry.rect, region));
    if (!split || (split.direction !== "right" && split.direction !== "down")) return null;
    const vertical = split.direction === "right";
    const boundary = vertical ? region.x + region.width * split.ratio : region.y + region.height * split.ratio;
    const firstPanes = panes.filter((entry) => (vertical ? entry.rect.x + entry.rect.width / 2 : entry.rect.y + entry.rect.height / 2) < boundary);
    const secondPanes = panes.filter((entry) => !firstPanes.includes(entry));
    // Native rectangles round to terminal cells; use actual child bounds to locate nested splits.
    const bounds = (entries: PaneLayoutSnapshot["panes"]): PaneLayoutRect => {
      const x = Math.min(...entries.map((entry) => entry.rect.x));
      const y = Math.min(...entries.map((entry) => entry.rect.y));
      return { x, y, width: Math.max(...entries.map((entry) => entry.rect.x + entry.rect.width)) - x,
        height: Math.max(...entries.map((entry) => entry.rect.y + entry.rect.height)) - y };
    };
    if (firstPanes.length === 0 || secondPanes.length === 0) return null;
    const first = build(firstPanes, bounds(firstPanes), depth + 1);
    const second = build(secondPanes, bounds(secondPanes), depth + 1);
    return first === null || second === null ? null : {
      kind: "split", id: `native:${encodeURIComponent(machineId)}:${encodeURIComponent(layout.workspace_id)}:${encodeURIComponent(layout.tab_id)}:${encodeURIComponent(split.id)}`,
      direction: vertical ? "right" : "down", ratio: split.ratio, first, second,
    };
  };
  return parseDockLayout(build(layout.panes, layout.area, 0));
}
