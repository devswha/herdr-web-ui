import { useEffect } from "react";
import { useSettings } from "./settings.ts";
import { recordedShortcutKey, recordShortcutBinding, resolveShortcutBinding, sameShortcutBinding, type ShortcutEventLike, type ShortcutOverrides, type ShortcutSpec } from "./shortcutBindings.ts";
export type { ShortcutEventLike } from "./shortcutBindings.ts";

import type { AppActions } from "./actions.ts";

export const SHORTCUTS = [
  { id: "palette", label: "Command palette", keys: ["Mod", "Shift", "K"] },
  { id: "find", label: "Find in terminal", keys: ["Mod", "Shift", "F"] },
  { id: "toggle-view", label: "Switch chat / terminal", keys: ["Mod", "Shift", "J"] },
  { id: "toggle-sidebar", label: "Toggle sidebar", keys: ["Mod", "Shift", "B"] },
  // Mod+Shift+N keeps working where the browser lets it through (the installed app), but Chrome
  // keeps Ctrl+Shift+N for a new incognito window in a tab: O is the one shown, and works in both
  { id: "new-session", label: "New workspace", keys: ["Mod", "Shift", "O"] },
  { id: "previous-pane", label: "Previous pane", keys: ["Mod", "Shift", "ArrowUp"] },
  { id: "next-pane", label: "Next pane", keys: ["Mod", "Shift", "ArrowDown"] },
  { id: "settings", label: "Settings", keys: ["Mod", "Shift", ","] },
  // listed only: held, not dispatched; VoiceInput.tsx listens for it itself (isVoiceShortcut)
  { id: "voice", label: "Dictate (hold)", keys: ["Mod", "Shift", "Space"] },
] as const;

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

const KEY_TO_ID: Readonly<Record<string, ShortcutId>> = {
  k: "palette",
  f: "find",
  j: "toggle-view",
  b: "toggle-sidebar",
  n: "new-session",
  o: "new-session",
  ArrowUp: "previous-pane",
  ArrowDown: "next-pane",
  ",": "settings",
};

export function shortcutKeys(id: ShortcutId, overrides: ShortcutOverrides): ShortcutSpec[] {
  if (id === "voice") return ["Space"];
  if (Object.hasOwn(overrides, id)) return overrides[id] ? [overrides[id]!] : [];
  return Object.entries(KEY_TO_ID).filter(([, action]) => action === id).map(([key]) => key);
}

export function shortcutDisplayKeys(id: ShortcutId, overrides: ShortcutOverrides): string[] {
  const shortcut = SHORTCUTS.find((candidate) => candidate.id === id)!;
  if (id === "voice" || !Object.hasOwn(overrides, id)) return [...shortcut.keys];
  const key = overrides[id];
  if (!key) return [];
  if (typeof key === "string") return ["Mod", "Shift", key.length === 1 ? key.toUpperCase() : key];
  return [...(key.ctrlKey ? ["Ctrl"] : []), ...(key.metaKey ? ["Meta"] : []), ...(key.altKey ? ["Alt"] : []), ...(key.shiftKey ? ["Shift"] : []), key.key.length === 1 ? key.key.toUpperCase() : key.key];
}

export function shortcutConflict(id: ShortcutId, keys: ShortcutSpec[], overrides: ShortcutOverrides, platformIsMac = isMacPlatform()): boolean {
  return SHORTCUTS.some((other) => other.id !== id && shortcutKeys(other.id, overrides).some((key) => keys.some((candidate) => sameShortcutBinding(resolveShortcutBinding(candidate, platformIsMac), resolveShortcutBinding(key, platformIsMac)))));
}

export function matchShortcut(event: ShortcutEventLike, platformIsMac: boolean, overrides: ShortcutOverrides = {}): ShortcutId | null {
  const binding = recordShortcutBinding(event);
  if (binding === null || isVoiceShortcut(event, platformIsMac)) return null;
  for (const shortcut of SHORTCUTS) {
    if (shortcut.id === "voice") continue;
    const override = overrides[shortcut.id];
    if (override && sameShortcutBinding(binding, resolveShortcutBinding(override, platformIsMac))) return shortcut.id;
  }
  const key = recordedShortcutKey(event, platformIsMac);
  if (key === null) return null;
  const id = KEY_TO_ID[key];
  return id && !Object.hasOwn(overrides, id) ? id : null;
}

/** Mod+Shift+Space, held to dictate. matchShortcut never returns "voice": it has no action. */
export function isVoiceShortcut(event: ShortcutEventLike, platformIsMac: boolean): boolean {
  const hasMod = platformIsMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return hasMod && event.shiftKey && !event.altKey && (event.code === "Space" || event.key === " ");
}

/**
 * Mod+Shift+ArrowUp/ArrowDown move the selection in a text field (on a Mac Cmd+Shift+↑ selects to
 * the start of the text): in the message box or any other field they stay the field's, and switch
 * panes everywhere else, the terminal included (its own input element is xterm's, not a field to edit).
 */
export interface KeyTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  classList?: { contains(name: string): boolean };
}

export function keepsArrowsForText(target: KeyTargetLike | EventTarget | null): boolean {
  if (target === null || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as KeyTargetLike;
  if (element.classList?.contains("xterm-helper-textarea")) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  const type = element.type ?? "";
  return type === "text" || type === "search" || type === "url" || type === "email" || type === "password" || type === "tel" || type === "number" || type === "";
}

/**
 * Terminal key handlers share the global matcher so app shortcuts never become pane input.
 */
export function isAppShortcut(event: ShortcutEventLike, overrides: ShortcutOverrides = {}): boolean {
  return matchShortcut(event, isMacPlatform(), overrides) !== null;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

export function modKeyLabel(): string {
  return isMacPlatform() ? "⌘" : "Ctrl";
}

export function formatKeys(keys: readonly string[]): string[] {
  const mod = modKeyLabel();
  return keys.map((key) => key === "Mod" ? mod : key === "Meta" ? (isMacPlatform() ? "⌘" : "Meta") : key);
}

/** A focused recorder owns its keystrokes before the global window capture listeners run. */
export function isShortcutRecordingTarget(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest("[data-shortcut-recording]") !== null;
}

export function useShortcuts(actions: AppActions, enabled: boolean): void {
  const { settings } = useSettings();
  useEffect(() => {
    if (!enabled) return;
    const platformIsMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isShortcutRecordingTarget(event.target)) return;
      const shortcut = matchShortcut(event, platformIsMac, settings.shortcutOverrides);
      if (shortcut === null) return;
      if (event.key.startsWith("Arrow") && !Object.hasOwn(settings.shortcutOverrides, shortcut) && keepsArrowsForText(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      switch (shortcut) {
        case "palette":
          actions.openPalette();
          break;
        case "find":
          actions.openFind();
          break;
        case "toggle-view":
          actions.toggleView();
          break;
        case "toggle-sidebar":
          actions.toggleSidebar();
          break;
        case "new-session":
          actions.openNewSession();
          break;
        case "previous-pane":
          actions.selectAdjacentPane(-1);
          break;
        case "next-pane":
          actions.selectAdjacentPane(1);
          break;
        case "settings":
          actions.openSettings();
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [actions, enabled, settings.shortcutOverrides]);
}
