/**
 * The pane each workspace row and each tab was last seen on in this browser, per PC: a row or a
 * tab picked again opens where it was left, not on the pane herdr's own window has in front.
 * Kept in localStorage, so a phone that dropped the page in the background, or a reload after an
 * update, still knows. A remembered pane that has since closed is skipped by the caller's lookup.
 */
export type ViewedScope = "workspace" | "tab";

const KEY = "herdr-web-ui:last-viewed-pane";
const LIMIT = 200;

let entries: Map<string, string> | null = null;

const scopeKey = (scope: ViewedScope, machineId: string, id: string): string => `${scope}:${machineId}:${id}`;

/** a stored value back into entries, oldest first; anything malformed is dropped */
export function parseViewedPanes(raw: string | null): Map<string, string> {
  const parsed = new Map<string, string>();
  if (raw === null) return parsed;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return parsed;
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string") parsed.set(entry[0], entry[1]);
    }
  } catch { /* a damaged value starts over */ }
  return parsed;
}

/** the newest entry last, the oldest ones dropped past `limit` */
export function withViewedPane(current: ReadonlyMap<string, string>, key: string, paneId: string, limit = LIMIT): Map<string, string> {
  const next = new Map(current);
  next.delete(key);
  next.set(key, paneId);
  for (const oldest of next.keys()) {
    if (next.size <= limit) break;
    next.delete(oldest);
  }
  return next;
}

function load(): Map<string, string> {
  if (entries === null) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* storage denied: memory only */ }
    entries = parseViewedPanes(raw);
  }
  return entries;
}

export function lastViewedPane(scope: ViewedScope, machineId: string, id: string): string | undefined {
  return load().get(scopeKey(scope, machineId, id));
}

export function rememberViewedPane(scope: ViewedScope, machineId: string, id: string, paneId: string): void {
  const key = scopeKey(scope, machineId, id);
  const current = load();
  if (current.get(key) === paneId) return;
  entries = withViewedPane(current, key, paneId);
  try { localStorage.setItem(KEY, JSON.stringify([...entries])); } catch { /* storage denied: memory only */ }
}
