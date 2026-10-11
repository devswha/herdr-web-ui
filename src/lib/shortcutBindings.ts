import { physicalKey } from "./keys.ts";

export interface ShortcutBinding {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
/** Strings are legacy Mod+Shift keys; new recordings retain the exact modifiers. */
export type ShortcutSpec = string | ShortcutBinding;
export type ShortcutOverrides = Record<string, ShortcutSpec | null>;
export const CUSTOM_SHORTCUT_IDS = ["palette", "find", "toggle-view", "toggle-sidebar", "new-session", "previous-pane", "next-pane", "settings"];

export interface ShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const NAMED_SHORTCUT_KEY = /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|Enter|Tab|Escape|Backspace|Delete|Insert|Space|F([1-9]|1[0-9]|2[0-4]))$/;

/** Printable Unicode keys need no alphabet list; named keys use the KeyboardEvent spelling. */
function validShortcutKey(key: string): boolean {
  return /^[\p{L}\p{N}\p{P}\p{S}]\p{M}*$/u.test(key)
    || NAMED_SHORTCUT_KEY.test(key);
}

/** Recording and dispatch share layout handling, including shifted digits and IME protection. */
export function recordShortcutBinding(event: ShortcutEventLike): ShortcutBinding | null {
  if (event.isComposing || event.keyCode === 229 || ["Dead", "Unidentified", "Process"].includes(event.key)) return null;
  const code = event.code ?? "";
  const typedKey = event.key.normalize("NFC");
  const latinLetter = /^\p{Script=Latin}\p{M}*$/u.test(typedKey);
  const nonLatinLetter = /^\p{L}\p{M}*$/u.test(typedKey) && !latinLetter;
  const letter = nonLatinLetter ? physicalKey(typedKey, code) : typedKey;
  // Hungarian Ó occupies Digit0: a Latin letter keeps its own binding, even on a digit key.
  const key = latinLetter ? letter.toLowerCase() : code === "Space" || typedKey === " " ? "Space"
    : code === "Comma" ? "," : /^Digit[0-9]$/.test(code) ? code.slice(-1) : letter.length === 1 ? letter.toLowerCase() : letter;
  return validShortcutKey(key) ? { key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey } : null;
}

/** Manual entry has no physical code: reject keys whose recorded identity may depend on layout. */
export function manualShortcutBinding(key: string, modifiers: Omit<ShortcutBinding, "key">): ShortcutBinding | null {
  const normalized = key.normalize("NFC");
  if (!/^(?:\p{Script=Latin}\p{M}*|[0-9,])$/u.test(normalized) && !NAMED_SHORTCUT_KEY.test(normalized)) return null;
  return recordShortcutBinding({ ...modifiers, key: normalized });
}

/** Default and legacy bindings still use this platform's Mod+Shift convention. */
export function recordedShortcutKey(event: ShortcutEventLike, platformIsMac: boolean): string | null {
  const binding = recordShortcutBinding(event);
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return binding && hasMod && event.shiftKey && !event.altKey ? binding.key : null;
}

export function resolveShortcutBinding(spec: ShortcutSpec, platformIsMac: boolean): ShortcutBinding {
  return typeof spec === "string" ? { key: spec, ctrlKey: !platformIsMac, metaKey: platformIsMac, altKey: false, shiftKey: true } : spec;
}

export function sameShortcutBinding(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return a.key === b.key && a.ctrlKey === b.ctrlKey && a.metaKey === b.metaKey && a.altKey === b.altKey && a.shiftKey === b.shiftKey;
}

export function isReservedShortcutBinding(binding: ShortcutBinding, platformIsMac: boolean): boolean {
  const hasMod = platformIsMac ? binding.metaKey && !binding.ctrlKey : binding.ctrlKey && !binding.metaKey;
  if (!hasMod || binding.altKey) return false;
  if (binding.shiftKey) return isReservedShortcutKey(binding.key, platformIsMac);
  // Common browser commands without Shift; warnings do not prevent an explicit binding.
  return ["a", "c", "v", "x", "z", "f", "l", "n", "t", "w", "p", "r", "s", "o"].includes(binding.key)
    || (platformIsMac && ["q", "h", "m", "Space", "Tab"].includes(binding.key));
}

/**
 * Narrow warning list for Mod+Shift browser/OS reservations; this is not exhaustive:
 * Mod+Shift+N opens Chromium private browsing, Mod+Shift+T reopens a closed browser tab,
 * Mod+Shift+B opens or toggles browser bookmarks, and Firefox uses Mod+Shift+P for a private
 * window. Mod+Shift+W closes a browser window. On non-Mac platforms Chromium/Firefox also
 * reserve Mod+Shift+C/I/J for DevTools and Chromium reserves Mod+Shift+O for bookmarks.
 * macOS uses Cmd+Shift+3/4/5 for screenshots and Cmd+Shift+Q for logout.
 * This only reports likely conflicts; configured and default bindings remain valid.
 */
export function isReservedShortcutKey(key: string, platformIsMac: boolean): boolean {
  const normalized = /^[a-z]$/i.test(key) ? key.toLowerCase() : key;
  if (normalized === "n" || normalized === "t" || normalized === "b" || normalized === "p" || normalized === "w") return true;
  return platformIsMac
    ? normalized === "3" || normalized === "4" || normalized === "5" || normalized === "q"
    : normalized === "c" || normalized === "i" || normalized === "j" || normalized === "o";
}

export function sanitizeShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ShortcutOverrides = {};
  for (const id of CUSTOM_SHORTCUT_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (value === null) result[id] = null;
    else if (typeof value === "string") {
      const normalized = value.normalize("NFC");
      const key = /^\p{L}\p{M}*$/u.test(normalized) ? normalized.toLowerCase().normalize("NFC") : normalized;
      // Space belongs to the fixed hold-to-dictate binding.
      if (key !== "Space" && validShortcutKey(key)) result[id] = key;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      const binding = value as Record<string, unknown>;
      if (typeof binding["key"] !== "string" || !["ctrlKey", "metaKey", "altKey", "shiftKey"].every((name) => typeof binding[name] === "boolean")) continue;
      const normalized = binding["key"].normalize("NFC");
      const key = /^\p{L}\p{M}*$/u.test(normalized) ? normalized.toLowerCase().normalize("NFC") : normalized;
      if (validShortcutKey(key)) result[id] = { key, ctrlKey: binding["ctrlKey"] as boolean, metaKey: binding["metaKey"] as boolean, altKey: binding["altKey"] as boolean, shiftKey: binding["shiftKey"] as boolean };
    }
  }
  return result;
}
