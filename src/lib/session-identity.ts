import type { CSSProperties } from "react";
import { paneStorageId, type PaneTarget } from "../../shared/machines.ts";

/** Retain identities for removed views so re-adding or rearranging never recolors a session. */
export function assignViewNumbers(previous: ReadonlyMap<string, number>, targets: readonly PaneTarget[]): ReadonlyMap<string, number> {
  const missing = targets.filter((target) => !previous.has(paneStorageId(target.machine_id, target.pane_id)));
  if (!missing.length) return previous;
  const next = new Map(previous);
  for (const target of missing) {
    const key = paneStorageId(target.machine_id, target.pane_id);
    if (!next.has(key)) next.set(key, next.size + 1);
  }
  return next;
}

export function sessionStyle(number: number | undefined): (CSSProperties & { "--session-color": string }) | undefined {
  return number === undefined ? undefined : { "--session-color": `var(--session-${(number - 1) % 8 + 1})` };
}
