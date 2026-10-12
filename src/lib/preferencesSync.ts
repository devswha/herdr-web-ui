/**
 * Keeps the shared settings and the pins (shared/preferences.ts) the same in every browser of this
 * server. Loaded once the app is in (never before the access gate): what the server holds is laid
 * over this browser's settings; a setting nobody has changed since stays this browser's own, and
 * opening a page writes nothing. A change here sends just what changed, once the settings rest;
 * another browser's arrives as a `preferences` event. Last write wins, setting by setting.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import { ApiError, fetchPreferences, savePreferences } from "./api.ts";
import { sanitizeSettings, sharedSettings, useSettings, type Settings } from "./settings.ts";
import { currentSidebarPins, setSidebarPins, subscribeSidebarPins } from "./sidebarPins.ts";

const SEND_AFTER_MS = 600;
/** a send that failed on the way (the network, a restart) is tried again after this */
const RETRY_MS = 5_000;

type Shared = ReturnType<typeof sharedSettings>;
interface Baseline { settings: Shared; pins: readonly string[] }

/** The settings with the shared part of `remote` over them, as the browser will hold them. */
export function withShared(settings: Settings, remote: Pick<SharedPreferences, "settings">): Settings {
  return sanitizeSettings({ ...settings, ...remote.settings });
}

/** What changed here since `base`: the shared settings that differ, and the pins when they do; null when nothing did. */
export function preferencesChange(base: Baseline, settings: Settings, pins: readonly string[]): PreferencesChange | null {
  const now = sharedSettings(settings);
  const changed = Object.fromEntries(Object.entries(now).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(base.settings[key as keyof Shared])));
  const pinsChanged = JSON.stringify(pins) !== JSON.stringify(base.pins);
  if (Object.keys(changed).length === 0 && !pinsChanged) return null;
  return pinsChanged ? { settings: changed, pins: [...pins] } : { settings: changed };
}

export function usePreferencesSync(enabled: boolean): (preferences: SharedPreferences) => void {
  const { settings, update } = useSettings();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const latest = useRef({ settings, pins });
  latest.current = { settings, pins };
  // what this browser held when it last matched the server; null until loaded
  const base = useRef<Baseline | null>(null);
  const revision = useRef(0);
  // a server without the route: sync stands down, settings stay this browser's
  const off = useRef(false);
  // a watching device: it takes what the others share and sends nothing; a change of its own lasts until the next shared one
  const readOnly = useRef(false);
  const sending = useRef(false);
  // the send effect runs again when this moves: after a send, or a failed one's wait
  const [attempt, setAttempt] = useState(0);

  const apply = useCallback((remote: SharedPreferences) => {
    const next = withShared(latest.current.settings, remote);
    revision.current = Math.max(revision.current, remote.revision);
    base.current = { settings: sharedSettings(next), pins: remote.pins };
    update(Object.fromEntries(Object.keys(remote.settings).map((key) => [key, next[key as keyof Settings]])) as Partial<Settings>);
    setSidebarPins(remote.pins);
  }, [update]);

  // what another browser wrote; an older one, or this browser's own coming back, is already here
  const receive = useCallback((remote: SharedPreferences) => {
    if (off.current || base.current === null || remote.revision <= revision.current) return;
    // a change made here and not yet sent wins: it goes out next, over this one
    if (!readOnly.current && preferencesChange(base.current, latest.current.settings, latest.current.pins) !== null) return;
    apply(remote);
  }, [apply]);

  useEffect(() => {
    if (!enabled || base.current !== null || off.current) return;
    let cancelled = false;
    fetchPreferences().then((remote) => {
      if (cancelled) return;
      if (remote === null) { off.current = true; return; }
      if (remote.revision > 0) apply(remote);
      else base.current = { settings: sharedSettings(latest.current.settings), pins: latest.current.pins };
    }).catch(() => { /* tried again on the next sign-in or load */ });
    return () => { cancelled = true; };
  }, [enabled, apply]);

  const change = base.current === null ? null : preferencesChange(base.current, settings, pins);
  const pending = change === null ? null : JSON.stringify(change);
  useEffect(() => {
    if (!enabled || off.current || readOnly.current || pending === null || sending.current) return;
    const timer = window.setTimeout(() => {
      const body = JSON.parse(pending) as PreferencesChange;
      const sent = { settings: sharedSettings(latest.current.settings), pins: latest.current.pins };
      sending.current = true;
      savePreferences(body).then((saved) => {
        revision.current = Math.max(revision.current, saved.revision);
        base.current = sent;
        sending.current = false;
        // what changed while this was on its way goes out now
        setAttempt((count) => count + 1);
      }).catch((error: unknown) => {
        sending.current = false;
        if (error instanceof ApiError && error.status === 403) readOnly.current = true;
        else if (error instanceof ApiError && error.status === 404) off.current = true;
        else window.setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
      });
    }, SEND_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, pending, attempt]);

  return receive;
}
