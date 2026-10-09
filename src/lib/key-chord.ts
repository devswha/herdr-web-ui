import { physicalKey } from "./keys.ts";
import type { ShortcutEventLike } from "./shortcuts.ts";

export interface Chord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

const NAMED: Readonly<Record<string, string>> = {
  tab: "Tab", enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape",
  space: " ", backspace: "Backspace", delete: "Delete",
  left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  minus: "-", comma: ",", period: ".", slash: "/", backslash: "\\",
  semicolon: ";", quote: "'", backtick: "`", equal: "=",
};
const SHIFTED: Readonly<Record<string, string>> = {
  "?": "/", "{": "[", "}": "]", "<": ",", ">": ".", "_": "-", plus: "=", "+": "=",
  ":": ";", '"': "'", "~": "`", "|": "\\", ampersand: "7", "&": "7",
};
const MODIFIERS: Readonly<Record<string, "ctrl" | "alt" | "shift" | "meta">> = {
  ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt",
  shift: "shift", cmd: "meta", command: "meta", super: "meta", meta: "meta",
};

export function chordKey(chord: Chord): string {
  return `${+chord.ctrl}${+chord.alt}${+chord.shift}${+chord.meta}:${chord.key}`;
}

export interface ParsedBinding {
  readonly prefixed: boolean;
  readonly chords: readonly { readonly chord: Chord; readonly index: number | null }[];
}

export function parseBinding(text: string): ParsedBinding | null {
  if (!text) return null;
  const tokens = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const prefixed = tokens[0]?.toLowerCase() === "prefix";
  if (prefixed) tokens.shift();
  const last = tokens.pop();
  if (!last) return null;
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  for (const token of tokens) {
    const modifier = Object.hasOwn(MODIFIERS, token.toLowerCase()) ? MODIFIERS[token.toLowerCase()] : undefined;
    if (!modifier) return null;
    mods[modifier] = true;
  }
  if (last === "1..9") return {
    prefixed, chords: Array.from({ length: 9 }, (_, i) => ({ chord: { ...mods, key: String(i + 1) }, index: i + 1 })),
  };
  const lower = last.toLowerCase();
  const shifted = Object.hasOwn(SHIFTED, lower) ? SHIFTED[lower] : undefined;
  const key = shifted ?? (Object.hasOwn(NAMED, lower) ? NAMED[lower] : /^[a-z0-9\[\]\-.,/\\;'`=]$/.test(lower) ? lower : undefined);
  if (key === undefined) return null;
  return { prefixed, chords: [{ chord: { ...mods, shift: mods.shift || shifted !== undefined || /^[A-Z]$/.test(last), key }, index: null }] };
}

/** Share web shortcuts' layout semantics: Latin letters stay typed, non-Latin uses key position. */
export function chordOfEvent(event: ShortcutEventLike): Chord | null {
  if (event.key === "Dead" || event.key === "Process" || event.key === "Unidentified") return null;
  const nonLatin = /^\p{L}$/u.test(event.key) && !/^\p{Script=Latin}$/u.test(event.key);
  const typed = nonLatin ? physicalKey(event.key, event.code ?? "") : event.key;
  const shifted = Object.hasOwn(SHIFTED, typed) ? SHIFTED[typed] : undefined;
  const key = /^Digit[0-9]$/.test(event.code ?? "") ? event.code?.slice(-1)
    : shifted ?? (typed.length === 1 ? typed.toLowerCase() : typed);
  if (!key || ["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(key)) return null;
  return { key, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey };
}
