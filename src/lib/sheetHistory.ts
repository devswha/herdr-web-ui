/**
 * A phone's bottom sheet is a history entry, so the system Back closes it instead of going to the
 * pane before (deep links make each pane its own entry). The entry keeps the address it opened on.
 * A sheet closed any other way steps back off its entry once whatever it ran has written its own
 * history; an entry left under a newer one (an item that opened another pane) is stepped over
 * when Back lands on it, since the entry below it names the same place.
 */
import { useEffect, useRef } from "react";

const KEY = "herdr-web-ui:sheet";

const open = new Map<string, () => void>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
let pushing = false;

function sheetOf(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const id = (state as Record<string, unknown>)[KEY];
  return typeof id === "string" ? id : null;
}

function without(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [KEY]: _, ...rest } = state as Record<string, unknown>;
  return rest;
}

function enter(onBack: () => void, reuse: string | null): string {
  // StrictMode's second mount, or a sheet reopened before its entry went: the same entry
  const timer = reuse === null ? undefined : leaving.get(reuse);
  if (reuse !== null && timer !== undefined && sheetOf(window.history.state) === reuse) {
    clearTimeout(timer);
    leaving.delete(reuse);
    open.set(reuse, onBack);
    return reuse;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const base = window.history.state;
  pushing = true;
  try { window.history.pushState({ ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id }, ""); }
  finally { pushing = false; }
  open.set(id, onBack);
  return id;
}

function leave(id: string): void {
  if (!open.delete(id)) return;
  // after the closing click's commit and effects, which may push an entry of their own
  leaving.set(id, setTimeout(() => {
    leaving.delete(id);
    if (sheetOf(window.history.state) === id) window.history.back();
  }, 0));
}

if (typeof window !== "undefined") {
  // an entry pushed over a sheet's copies its state (the file viewer's does): only the sheet's own carries its mark
  const history = window.history;
  const push = history.pushState.bind(history);
  history.pushState = ((state: unknown, ...rest: [string, (string | URL | null)?]) => push(pushing ? state : without(state), ...rest)) as History["pushState"];
  window.addEventListener("popstate", (event) => {
    const landed = sheetOf(event.state);
    for (const [id, onBack] of [...open]) {
      if (id === landed) continue;
      open.delete(id);
      onBack();
    }
    if (landed !== null && !open.has(landed) && !leaving.has(landed)) {
      window.history.replaceState(without(event.state), "");
      window.history.back();
    }
  });
  // a reload keeps the history and not the sheet: its entry is an ordinary one now
  if (sheetOf(window.history.state) !== null) window.history.replaceState(without(window.history.state), "");
}

/** While `active`, the sheet holds a history entry; Back calls `onBack`. */
export function useSheetHistory(active: boolean, onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const entry = enter(() => latest.current(), id.current);
    id.current = entry;
    return () => leave(entry);
  }, [active]);
}
