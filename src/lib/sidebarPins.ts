/**
 * The browser's pinned Agents roster. Keys include the PC and pane so a pane id
 * reused on another PC never receives the old PC's pin.
 */

const STORAGE_KEY = "herdr-web-ui:sidebar-agent-pins";

export function sidebarPinKey(machineId: string, paneId: string): string {
  return `${machineId}:${paneId}`;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function loadSidebarPins(): string[] {
  const value = storage()?.getItem(STORAGE_KEY);
  if (value === undefined || value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((key): key is string => typeof key === "string" && key.length > 0))] : [];
  } catch { return []; }
}

export function saveSidebarPins(keys: readonly string[]): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify([...new Set(keys)])); }
  catch { /* storage denied: pins last for the session */ }
}

export function toggleSidebarPin(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((current) => current !== key) : [...keys, key];
}

export function pruneSidebarPins(keys: readonly string[], liveKeys: ReadonlySet<string>): string[] {
  return keys.filter((key) => liveKeys.has(key));
}

/** Pinned rows keep their saved order. Other rows retain the source roster order. */
export function orderPinnedRows<T>(rows: readonly T[], keys: readonly string[], keyOf: (row: T) => string): T[] {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));
  const pinned = keys.flatMap((key) => {
    const row = byKey.get(key);
    return row === undefined ? [] : [row];
  });
  const pinnedKeys = new Set(pinned.map(keyOf));
  return [...pinned, ...rows.filter((row) => !pinnedKeys.has(keyOf(row)))];
}
