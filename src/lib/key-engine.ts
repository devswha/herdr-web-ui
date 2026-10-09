import type { HerdrKeymap } from "../../shared/herdr-keymap.ts";
import { chordKey, chordOfEvent, parseBinding, type Chord } from "./key-chord.ts";
import { isHerdrWebAction, type KeyAction } from "./key-targets.ts";
import { isReservedShortcutKey, type ShortcutOverrides } from "./shortcutBindings.ts";
import { isVoiceShortcut, matchShortcut, type ShortcutEventLike } from "./shortcuts.ts";

export type BindingStatus = "active" | "disabled" | "unsupported" | "invalid" | "protected" | "duplicate" | "prefix-unavailable";
export interface BindingReport {
  readonly action: string;
  readonly keys: string;
  readonly status: BindingStatus;
}
export interface CompiledKeymap {
  readonly prefixes: ReadonlySet<string>;
  readonly prefixed: ReadonlyMap<string, KeyAction>;
  readonly direct: ReadonlyMap<string, KeyAction>;
  readonly report: readonly BindingReport[];
}
interface Policy {
  readonly mac: boolean;
  readonly overrides: ShortcutOverrides;
}

/** Protect defaults even when unbound: "Off" promises those keys back to the terminal. */
function webOwns(chord: Chord, policy: Policy): boolean {
  const event = { key: chord.key, ctrlKey: chord.ctrl, altKey: chord.alt, shiftKey: chord.shift, metaKey: chord.meta };
  return matchShortcut(event, policy.mac, policy.overrides) !== null || matchShortcut(event, policy.mac) !== null || isVoiceShortcut(event, policy.mac);
}

/**
 * Conservative import, not a browser-reservation detector. Direct chords/prefixes need a free
 * Mod+Shift letter/digit; on Mac a Ctrl-only letter is also a terminal prefix, not a Cmd action.
 * Alt/AltGraph, editing/clipboard and known browser/OS keys never become imported actions.
 */
function safeModified(chord: Chord, policy: Policy, prefix: boolean): boolean {
  if (webOwns(chord, policy) || chord.alt || !/^[a-z0-9]$/.test(chord.key)) return false;
  if (/^[acvxzy]$/.test(chord.key)) return false;
  if (prefix && policy.mac && chord.ctrl && !chord.meta) return /^[a-z]$/.test(chord.key);
  const mod = policy.mac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
  // Firefox page actions/downloads/history, Chrome search/clear data, and Linux Unicode input.
  return mod && chord.shift && !isReservedShortcutKey(chord.key, policy.mac)
    && !/^[adefghlmqrsu]$/.test(chord.key) && !(policy.mac && chord.key === "6");
}

export function compileKeymap(keymap: HerdrKeymap, policy: Policy): CompiledKeymap {
  const prefixes = new Set<string>();
  const prefixed = new Map<string, KeyAction>();
  const direct = new Map<string, KeyAction>();
  const report: BindingReport[] = [];
  const declaredPrefixes = new Set<string>();
  if (keymap.prefix.length === 0) report.push({ action: "prefix", keys: "", status: "disabled" });
  // Ambiguous chords execute nothing, including a supported default shadowed by a command
  // or terminal-only binding. Import must never turn an unsupported command into another action.
  const counts = new Map<string, number>();
  for (const text of [...keymap.bindings.flatMap((binding) => binding.keys), ...keymap.commands.map((command) => command.key)]) {
    const parsed = parseBinding(text);
    if (parsed) for (const { chord } of parsed.chords) {
      const key = `${parsed.prefixed}:${chordKey(chord)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const text of keymap.prefix) {
    const parsed = parseBinding(text);
    const chord = parsed?.chords[0]?.chord;
    if (parsed && !parsed.prefixed && parsed.chords.length === 1 && chord) declaredPrefixes.add(chordKey(chord));
    const status = !parsed || parsed.prefixed || parsed.chords.length !== 1 || !chord ? "invalid"
      : !safeModified(chord, policy, true) ? "protected"
      : prefixes.has(chordKey(chord)) || counts.has(`false:${chordKey(chord)}`) ? "duplicate" : "active";
    report.push({ action: "prefix", keys: text, status });
    if (status === "active" && chord) prefixes.add(chordKey(chord));
  }
  for (const binding of keymap.bindings) {
    if (binding.keys.length === 0) report.push({ action: binding.action, keys: "", status: "disabled" });
    for (const text of binding.keys) {
      const parsed = parseBinding(text);
      const supported = isHerdrWebAction(binding.action);
      const indexed = ["switch_tab", "switch_workspace", "focus_agent"].includes(binding.action);
      let status: BindingStatus = !supported ? "unsupported" : !parsed || (indexed && parsed.chords.some((item) => item.index === null)) ? "invalid"
        : parsed.prefixed && prefixes.size === 0 ? "prefix-unavailable" : "active";
      if (status === "active" && parsed && supported) {
        const table = parsed.prefixed ? prefixed : direct;
        // A sequence's second key may be plain/Shift, never another modified shortcut.
        if (parsed.chords.some(({ chord }) => parsed.prefixed
          ? chord.ctrl || chord.meta || chord.alt || chord.key === "Escape"
          : !safeModified(chord, policy, false))) status = "protected";
        else if (parsed.chords.some(({ chord }) => (counts.get(`${parsed.prefixed}:${chordKey(chord)}`) ?? 0) > 1
          || (!parsed.prefixed && declaredPrefixes.has(chordKey(chord))))) status = "duplicate";
        else for (const { chord, index } of parsed.chords) table.set(chordKey(chord), { action: binding.action, index });
      }
      report.push({ action: binding.action, keys: text, status });
    }
  }
  for (const command of keymap.commands) report.push({ action: command.description || `[[keys.command]] (${command.type})`, keys: command.key, status: "unsupported" });
  // With nothing executable behind it, do not take a terminal prefix just to swallow it.
  if (prefixed.size === 0) {
    prefixes.clear();
    for (let i = 0; i < report.length; i++) {
      const row = report[i];
      if (row?.action === "prefix" && row.status === "active") report[i] = { ...row, status: "prefix-unavailable" };
    }
  }
  return { prefixes, prefixed, direct, report };
}

export const PREFIX_TIMEOUT_MS = 1500;
export type KeyResult = { readonly kind: "pass" | "ignore" | "cancel" | "prefix" } | { readonly kind: "action"; readonly target: KeyAction };
export interface KeyContext {
  readonly now: number;
  readonly prefixUntil: number;
  readonly enabled: boolean;
  readonly inTextField: boolean;
  readonly modalOpen: boolean;
  readonly composing: boolean;
}

/** A pure, clock-injected decision; passing a key always cancels any pending prefix. */
export function resolveKey(compiled: CompiledKeymap, event: ShortcutEventLike & { repeat?: boolean; defaultPrevented?: boolean }, context: KeyContext): KeyResult {
  if (!context.enabled || context.inTextField || context.modalOpen || context.composing || event.isComposing
    || event.keyCode === 229 || event.repeat || event.defaultPrevented) return { kind: "pass" };
  // Shift arrives as its own keydown before prefix+Shift+N. It neither consumes a key nor
  // ends the sequence; the following chord still goes through all the ownership checks.
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return { kind: "ignore" };
  const chord = chordOfEvent(event);
  if (!chord) return { kind: "pass" };
  const key = chordKey(chord);
  if (context.prefixUntil > context.now) {
    if (chord.key === "Escape" && !chord.ctrl && !chord.alt && !chord.meta && !chord.shift) return { kind: "cancel" };
    const target = compiled.prefixed.get(key);
    return target ? { kind: "action", target } : { kind: "pass" };
  }
  if (compiled.prefixes.has(key)) return { kind: "prefix" };
  const target = compiled.direct.get(key);
  return target ? { kind: "action", target } : { kind: "pass" };
}
