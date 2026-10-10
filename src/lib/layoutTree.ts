/**
 * herdr's layout tree, read back from a snapshot's pane rects, so the demo (site/demo/transport.ts)
 * resizes as herdr does: a tab is binary splits, each node a rect cut once, right or down, at a
 * ratio, and a resize moves one split's ratio and lays every pane under it out again. The demo
 * has only the rects (its fixtures carry no splits), so the tree is recovered from them: a
 * node's panes are cut along the first line, vertical before horizontal, that no pane straddles.
 * A grid of four could be cut either way; the vertical cut is taken, as a layout made by
 * splitting right and then down has.
 *
 * Measured on herdr 0.9.3 (src/layout.rs resize_focused, src/app/api/panes.rs
 * handle_pane_resize): the split resized is the nearest one in the direction named, else the
 * nearest in the opposite direction; right and down add the amount to the ratio, left and up
 * take it off; the amount is capped at 0.5 and the ratio held to 0.1..0.9.
 */
import type { PaneDirection, PaneLayoutRect, PaneLayoutSnapshot } from "../../shared/protocol.ts";

type LayoutPane = PaneLayoutSnapshot["panes"][number];
type SplitDirection = "right" | "down";

interface Leaf { pane: LayoutPane; rect: PaneLayoutRect }
interface Split { direction: SplitDirection; ratio: number; rect: PaneLayoutRect; first: Node; second: Node }
type Node = Leaf | Split;

const isSplit = (node: Node): node is Split => "first" in node;
const start = (rect: PaneLayoutRect, direction: SplitDirection): number => (direction === "right" ? rect.x : rect.y);
const end = (rect: PaneLayoutRect, direction: SplitDirection): number => (direction === "right" ? rect.x + rect.width : rect.y + rect.height);

/** the first line across the rect, between its edges, that cuts no pane: a pane's far edge */
function cutLine(panes: LayoutPane[], rect: PaneLayoutRect, direction: SplitDirection): number | null {
  const lines = [...new Set(panes.map((pane) => end(pane.rect, direction)))]
    .filter((line) => line > start(rect, direction) && line < end(rect, direction))
    .sort((a, b) => a - b);
  return lines.find((line) => panes.every((pane) => end(pane.rect, direction) <= line || start(pane.rect, direction) >= line)) ?? null;
}

function build(panes: LayoutPane[], rect: PaneLayoutRect): Node | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) return { pane: panes[0]!, rect };
  for (const direction of ["right", "down"] as const) {
    const line = cutLine(panes, rect, direction);
    if (line === null) continue;
    const horizontal = direction === "right";
    const firstRect = horizontal ? { ...rect, width: line - rect.x } : { ...rect, height: line - rect.y };
    const secondRect = horizontal ? { ...rect, x: line, width: rect.x + rect.width - line } : { ...rect, y: line, height: rect.y + rect.height - line };
    const first = build(panes.filter((pane) => end(pane.rect, direction) <= line), firstRect);
    const second = build(panes.filter((pane) => start(pane.rect, direction) >= line), secondRect);
    if (!first || !second) return null;
    return { direction, ratio: (line - start(rect, direction)) / (horizontal ? rect.width : rect.height), rect, first, second };
  }
  return null;
}

/** the splits over the pane, root first, each with the side the pane is on */
function pathTo(node: Node, paneId: string): { split: Split; side: "first" | "second" }[] | null {
  if (!isSplit(node)) return node.pane.pane_id === paneId ? [] : null;
  for (const side of ["first", "second"] as const) {
    const rest = pathTo(node[side], paneId);
    if (rest) return [{ split: node, side }, ...rest];
  }
  return null;
}

/** the split whose cut the pane stands against on that side: herdr's nearest split in that direction */
function splitBeside(path: { split: Split; side: "first" | "second" }[], pane: LayoutPane, nav: PaneDirection): Split | null {
  const direction: SplitDirection = nav === "left" || nav === "right" ? "right" : "down";
  const side = nav === "right" || nav === "down" ? "first" : "second";
  const found = path.find((step) => {
    if (step.split.direction !== direction || step.side !== side) return false;
    const child = step.split[side].rect;
    return side === "first" ? end(pane.rect, direction) === end(child, direction) : start(pane.rect, direction) === start(child, direction);
  });
  return found?.split ?? null;
}

function lay(node: Node, rect: PaneLayoutRect): LayoutPane[] {
  if (!isSplit(node)) return [{ ...node.pane, rect }];
  const horizontal = node.direction === "right";
  const extent = horizontal ? rect.width : rect.height;
  const first = Math.max(1, Math.min(extent - 1, Math.round(extent * node.ratio)));
  const firstRect = horizontal ? { ...rect, width: first } : { ...rect, height: first };
  const secondRect = horizontal ? { ...rect, x: rect.x + first, width: extent - first } : { ...rect, y: rect.y + first, height: extent - first };
  return [...lay(node.first, firstRect), ...lay(node.second, secondRect)];
}

const OPPOSITE: Record<PaneDirection, PaneDirection> = { left: "right", right: "left", up: "down", down: "up" };

/**
 * The layout's panes once `pane.resize` moved the pane's border that way by `amount` of the
 * split it belongs to, in the layout's order; null when no border of the pane can move that way
 * (a pane alone, an axis it fills, a ratio already at herdr's limit), or when the rects are not
 * a layout herdr could have made.
 */
export function resizeLayout(layout: PaneLayoutSnapshot, paneId: string, direction: PaneDirection, amount: number): LayoutPane[] | null {
  const pane = layout.panes.find((candidate) => candidate.pane_id === paneId);
  const root = pane && build(layout.panes, layout.area);
  const path = root ? pathTo(root, paneId) : null;
  if (!pane || !path) return null;
  const split = splitBeside(path, pane, direction) ?? splitBeside(path, pane, OPPOSITE[direction]);
  if (!split) return null;
  const grows = direction === "right" || direction === "down";
  const delta = Math.min(0.5, Math.abs(amount));
  const ratio = Math.min(0.9, Math.max(0.1, split.ratio + (grows ? delta : -delta)));
  if (ratio === split.ratio) return null;
  split.ratio = ratio;
  const relaid = new Map(lay(split, split.rect).map((laid) => [laid.pane_id, laid]));
  return layout.panes.map((candidate) => relaid.get(candidate.pane_id) ?? candidate);
}
