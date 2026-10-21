/**
 * Keeps the shared settings and the pins (shared/preferences.ts) the same in every browser of this
 * server. Loaded once the app is in (never before the access gate): what the server holds is laid
 * over this browser's settings, setting by setting; a setting nobody has shared yet stays this
 * browser's own, and opening a page writes nothing. A change here sends just what changed, once the
 * settings rest; another browser's arrives as a `preferences` event, and the server sends its whole
 * document each time the event stream opens, so a reconnected page catches up. Last write wins,
 * setting by setting: a change made here and not yet sent stays, and goes out over what arrived.
 * After three failed saves in a row, sending pauses until the user asks for Retry or the event stream
 * reopens; the change stays on this device meanwhile, and edits made then go out with it.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { mirrorPalette, SHARED_SETTING_KEYS, type PreferencesChange, type SharedPreferences, type SharedSettingKey } from "../../shared/preferences.ts";
import { ApiError, fetchPreferences, savePreferences } from "./api.ts";
import { DEFAULT_THEME } from "./themes.ts";
import { sanitizeSettings, sharedSettings, useSettings, type Settings } from "./settings.ts";
import { currentSidebarPins, setSidebarPins, subscribeSidebarPins } from "./sidebarPins.ts";
import { userErrorMessage, type UserError } from "./userError.ts";

const SEND_AFTER_MS = 600;
/** a request that failed on the way (the network, a restart) is tried again after this */
const RETRY_MS = 5_000;
/** failed saves in a row after which sending waits for Retry or a reopened event stream */
const PAUSE_AFTER = 3;

type Shared = Partial<Record<SharedSettingKey, unknown>>;
/** What this browser last knew the server to hold; `pins` is null while the server has held none. */
export interface Baseline { settings: Shared; pins: readonly string[] | null }
/** What this browser holds. */
export interface Local { settings: Settings; pins: readonly string[] }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What changed here since `base`: the shared settings that differ, and the pins when they do; null
 * when nothing did. While the server has held no pins, this browser's ride along with its first change,
 * so the pins of the browser that shares first are not lost.
 */
export function preferencesChange(base: Baseline, local: Local): PreferencesChange | null {
  const now = sharedSettings(local.settings);
  const settings = Object.fromEntries(Object.entries(now).filter(([key, value]) => !same(value, base.settings[key as SharedSettingKey])));
  const pinsChanged = base.pins !== null && !same(local.pins, base.pins);
  if (Object.keys(settings).length === 0 && !pinsChanged) return null;
  return pinsChanged || base.pins === null ? { settings, pins: [...local.pins] } : { settings };
}

export interface Taken {
  base: Baseline;
  /** the settings to set here */
  patch: Partial<Settings>;
  /** the pins to set here; null leaves them */
  pins: string[] | null;
}

/**
 * What a document from the server does here. Each setting it holds replaces this browser's, except
 * one changed here since `base` and not yet sent (it goes out next and wins), and one this browser
 * cannot read (a newer release's value stays the others'). `inFlight` is the change the document
 * answers: a value the server took is no longer this browser's own, so the document's stands (a
 * document from before the change landed is held until the answer, lib/preferencesSync.ts). With
 * `force` (a watching device, which sends nothing) every value is taken. The
 * baseline takes the server's values either way. The first pins the server holds join this browser's:
 * nobody loses pins when a server begins sharing them; after that the last write wins.
 */
export function takePreferences(base: Baseline, local: Local, remote: SharedPreferences, inFlight: PreferencesChange | null, force = false): Taken {
  const settings: Shared = { ...base.settings };
  const patch: Record<string, unknown> = {};
  const incoming = { ...remote.settings };
  // Read an old document's fixed-mode appearance into its active side. System's palette
  // was unused, so it must not replace this device's migrated pair. This is passive
  // migration only: the derived side advances the baseline too, never a correcting PUT.
  if (!("darkTheme" in incoming) && !("lightTheme" in incoming) && "palette" in incoming) {
    const mode = incoming.theme ?? base.settings.theme;
    if (mode === "dark") incoming.darkTheme = incoming.palette;
    if (mode === "light") incoming.lightTheme = incoming.palette;
  }
  for (const key of SHARED_SETTING_KEYS) {
    if (!(key in incoming)) continue;
    const value = incoming[key];
    if (!same(sanitizeSettings({ [key]: value })[key], value)) continue;
    const sent = inFlight !== null && key in inFlight.settings && same(inFlight.settings[key], local.settings[key]);
    const edited = !same(local.settings[key], base.settings[key]) && !sent;
    settings[key] = value;
    if (force || !edited) patch[key] = value;
  }
  // Palette is a derived mirror, not an independent local edit. A legacy document with no
  // sides must not overwrite a device's migrated System pair or provoke a correcting PUT.
  settings.palette = mirrorPalette(settings.theme, settings.darkTheme ?? DEFAULT_THEME, settings.lightTheme ?? DEFAULT_THEME);
  let pins: string[] | null = null;
  if (remote.pins !== undefined) {
    if (base.pins === null && !force) pins = [...remote.pins, ...local.pins.filter((pin) => !remote.pins!.includes(pin))];
    else {
      const sent = inFlight?.pins !== undefined && same(inFlight.pins, local.pins);
      const edited = !same(local.pins, base.pins) && !sent;
      if (force || !edited) pins = [...remote.pins];
    }
  }
  return { base: { settings, pins: remote.pins === undefined ? base.pins : [...remote.pins] }, patch: patch as Partial<Settings>, pins };
}

export interface PreferencesSync {
  /** a document the event stream brought */
  receive(preferences: SharedPreferences): void;
  /**
   * the last change the server refused to save, as a sentence for Settings (lib/userError.ts); null
   * once a save lands and nothing changed here since is still unsent. The change is sent again
   * meanwhile, until `paused`. A watching device and a server without the route are not refusals.
   */
  saveError: UserError | null;
  /** three saves failed in a row: nothing is sent until `retry` or `resubscribed` */
  paused: boolean;
  /** a Retry is waiting for its save's answer */
  retrying: boolean;
  /** the user's Retry: send what is unsent now, as it stands, and start counting failures again */
  retry(): void;
  /** the event stream opened again (App's EventSource): a paused change gets a new round */
  resubscribed(): void;
}

export function usePreferencesSync(enabled: boolean): PreferencesSync {
  const { settings, update } = useSettings();
  const pins = useSyncExternalStore(subscribeSidebarPins, currentSidebarPins, currentSidebarPins);
  const latest = useRef<Local>({ settings, pins });
  latest.current = { settings, pins };
  // what this browser last knew the server to hold; until a document arrives, what it holds itself
  const base = useRef<Baseline>({ settings: sharedSettings(settings), pins: null });
  const revision = useRef(0);
  // a document has arrived (the GET, or the event stream's opening): sending begins then
  const loadedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // a server without the route: sync stands down, settings stay this browser's
  const off = useRef(false);
  // a watching device: it takes what the others share and sends nothing; a change of its own lasts until the next shared one
  const readOnly = useRef(false);
  const inFlight = useRef<PreferencesChange | null>(null);
  // the newest document that arrived while a change was on its way: whether it is older or newer
  // than that change shows once the answer, with its revision, is here
  const held = useRef<SharedPreferences | null>(null);
  // the send effect runs again when this moves: after a send, or a failed one's wait
  const [attempt, setAttempt] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveError, setSaveError] = useState<UserError | null>(null);
  // failed save answers in a row, not renders or edits; a confirmed save starts it over
  const failures = useRef(0);
  const [paused, setPaused] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // the wait before a failed save goes again; a ref, so an answer that arrives after its effect was
  // cleaned up still sets a timer the next cleanup, a pause or unmounting cancels
  const retryTimer = useRef<number | undefined>(undefined);
  // mounted and enabled: an answer that arrives after either ended is still read, but sets no wait
  const live = useRef(false);
  // the baseline is a ref: a document that changes nothing here still moves what is pending
  const [, setTaken] = useState(0);

  const absorb = useCallback((remote: SharedPreferences) => {
    if (off.current || (loadedRef.current && remote.revision <= revision.current)) return;
    revision.current = Math.max(revision.current, remote.revision);
    const taken = takePreferences(base.current, latest.current, remote, inFlight.current, readOnly.current);
    base.current = taken.base;
    // a second document in the same tick compares against what this one set, not the last render
    latest.current = { settings: sanitizeSettings({ ...latest.current.settings, ...taken.patch }), pins: taken.pins ?? latest.current.pins };
    if (Object.keys(taken.patch).length > 0) update(taken.patch);
    if (taken.pins !== null) setSidebarPins(taken.pins);
    loadedRef.current = true;
    setLoaded(true);
    setTaken((count) => count + 1);
  }, [update]);

  const receive = useCallback((remote: SharedPreferences) => {
    if (inFlight.current === null) { absorb(remote); return; }
    if (held.current === null || remote.revision > held.current.revision) held.current = remote;
  }, [absorb]);

  // the change is answered or lost: what arrived meanwhile is read now (an older document is dropped by its revision)
  const settled = useCallback(() => {
    inFlight.current = null;
    const arrived = held.current;
    held.current = null;
    if (arrived !== null) absorb(arrived);
  }, [absorb]);

  useEffect(() => {
    if (!enabled || off.current || loaded) return;
    let cancelled = false;
    let retry: number | undefined;
    fetchPreferences().then((remote) => {
      if (cancelled) return;
      if (remote === null) { off.current = true; return; }
      receive(remote);
    }).catch(() => { if (!cancelled) retry = window.setTimeout(() => setLoadAttempt((count) => count + 1), RETRY_MS); });
    return () => { cancelled = true; window.clearTimeout(retry); };
  }, [enabled, loaded, loadAttempt, receive]);

  /** sending stopped for good (a watching device, a server without the route): nothing is unconfirmed */
  const standDown = useCallback(() => {
    failures.current = 0;
    setSaveError(null);
    setPaused(false);
    setRetrying(false);
  }, []);

  /** a new round of sends, for the user's Retry or a reopened event stream; one chain still, never a second */
  const resume = useCallback(() => {
    if (off.current || readOnly.current) return;
    failures.current = 0;
    setPaused(false);
    setAttempt((count) => count + 1);
  }, []);
  const retry = useCallback(() => {
    if (off.current || readOnly.current) return;
    // nothing unsent and nothing on its way: nothing is left to confirm, so nothing to wait for
    if (inFlight.current === null && preferencesChange(base.current, latest.current) === null) { standDown(); return; }
    setRetrying(true);
    resume();
  }, [resume, standDown]);

  const change = loaded ? preferencesChange(base.current, { settings, pins }) : null;
  const pending = change === null ? null : JSON.stringify(change);
  // what was unsent now matches the server (another browser saved the same): nothing is left to confirm
  useEffect(() => {
    if (loaded && pending === null && inFlight.current === null) standDown();
  }, [loaded, pending, standDown]);
  useEffect(() => {
    if (!enabled) return;
    live.current = true;
    return () => { live.current = false; window.clearTimeout(retryTimer.current); };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !loaded || off.current || readOnly.current || paused || pending === null || inFlight.current !== null) return;
    const timer = window.setTimeout(() => {
      const body = JSON.parse(pending) as PreferencesChange;
      inFlight.current = body;
      savePreferences(body).then((saved) => {
        // An older server silently drops new names. Acknowledge exactly what was sent, not
        // today's local value: an edit made while the request was in flight still goes next.
        for (const key of SHARED_SETTING_KEYS) {
          if (key in body.settings && !(key in saved.settings)) base.current.settings[key] = body.settings[key];
        }
        // the answer is the whole document as this change left it: one from elsewhere that landed
        // before comes with it, one that landed after was held and is read now
        absorb(saved);
        settled();
        failures.current = 0;
        setRetrying(false);
        // the status stays while a change made during the send is unconfirmed; it goes out now
        if (preferencesChange(base.current, latest.current) === null) setSaveError(null);
        setAttempt((count) => count + 1);
      }).catch((error: unknown) => {
        settled();
        if (error instanceof ApiError && error.status === 403) {
          readOnly.current = true;
          standDown();
        } else if (error instanceof ApiError && error.status === 404) {
          off.current = true;
          standDown();
        } else if (preferencesChange(base.current, latest.current) === null) {
          // undone while it was on its way (or another browser saved the same): nothing is unconfirmed
          standDown();
        } else {
          // the same refusal every RETRY_MS is one state, not a render each time
          const next = userErrorMessage(error);
          setSaveError((before) => before !== null && before.message === next.message && before.detail === next.detail ? before : next);
          setRetrying(false);
          failures.current += 1;
          if (failures.current >= PAUSE_AFTER) setPaused(true);
          else if (live.current) retryTimer.current = window.setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
        }
      });
    }, SEND_AFTER_MS);
    return () => { window.clearTimeout(timer); window.clearTimeout(retryTimer.current); };
  }, [enabled, loaded, paused, pending, attempt, absorb, settled, standDown]);

  return { receive, saveError, paused, retrying, retry, resubscribed: resume };
}
