/**
 * A tab's place in its workspace's row, as herdr's `tab.move` counts it: the insert index is a
 * gap in the order before the move, 0 to the tab count. The tab lands before the one at that
 * index, and the count puts it last; the gaps on either side of the tab leave it where it is.
 */

/** the row after `tabId` moves to `gap`, or null when the move changes nothing or is out of the row */
export function movedTabOrder(order: readonly string[], tabId: string, gap: number): string[] | null {
  const from = order.indexOf(tabId);
  if (from < 0 || !Number.isInteger(gap) || gap < 0 || gap > order.length || gap === from || gap === from + 1) return null;
  const next = order.filter((id) => id !== tabId);
  next.splice(gap > from ? gap - 1 : gap, 0, tabId);
  return next;
}

/** the gap one place to the left (-1) or the right (1) of the tab, or null at that end of the row */
export function stepGap(order: readonly string[], tabId: string, direction: -1 | 1): number | null {
  const from = order.indexOf(tabId);
  if (from < 0) return null;
  const gap = direction < 0 ? from - 1 : from + 2;
  return gap < 0 || gap > order.length ? null : gap;
}

/** the gap a tab dropped on `targetId` goes to: before the target, or after it when dropped on its far half */
export function dropGap(order: readonly string[], targetId: string, after: boolean): number | null {
  const at = order.indexOf(targetId);
  return at < 0 ? null : at + (after ? 1 : 0);
}
