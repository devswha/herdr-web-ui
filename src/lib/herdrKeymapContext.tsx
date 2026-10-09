import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HerdrKeymap, SessionSnapshot } from "../../shared/protocol.ts";
import type { AppActions } from "./actions.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { useSettings } from "./settings.ts";
import { isMacPlatform, keepsArrowsForText } from "./shortcuts.ts";
import { compileKeymap, PREFIX_TIMEOUT_MS, resolveKey, type CompiledKeymap } from "./key-engine.ts";
import { runHerdrAction } from "./key-targets.ts";

interface KeymapState {
  readonly compiled: CompiledKeymap | null;
  readonly error: string | null;
  readonly prefixActive: boolean;
  readonly reload: () => void;
}
const HerdrKeymapContext = createContext<KeymapState | null>(null);
export function useHerdrKeymap(): KeymapState {
  const state = useContext(HerdrKeymapContext);
  if (!state) throw new Error("useHerdrKeymap needs HerdrKeymapProvider");
  return state;
}

/** One PC-owned read, shared by the keyboard listener and Settings' binding descriptions. */
export function HerdrKeymapProvider({ actions, snapshot, paneId, enabled, children }: {
  actions: AppActions; snapshot: SessionSnapshot | null; paneId: string | null;
  enabled: boolean; children: ReactNode;
}) {
  const api = useMachineApi();
  const machineId = useMachineId();
  const { settings } = useSettings();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ api: typeof api; revision: number; map: HerdrKeymap | null; error: string | null } | null>(null);
  const [prefixActive, setPrefixActive] = useState(false);
  const reload = useMemo(() => () => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!settings.importHerdrKeys) { setLoaded(null); return; }
    let cancelled = false;
    void api.fetchHerdrKeymap().then((map) => {
      if (!cancelled) setLoaded({ api, revision, map, error: null });
    }).catch((error: unknown) => {
      if (!cancelled) setLoaded({ api, revision, map: null, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [api, settings.importHerdrKeys, revision]);
  // A response from the PC/setting just left is ineligible even before effect cleanup.
  const owned = settings.importHerdrKeys && loaded?.api === api && loaded.revision === revision ? loaded : null;
  const compiled = useMemo(() => owned?.map ? compileKeymap(owned.map, { mac: isMacPlatform(), overrides: settings.shortcutOverrides }) : null,
    [owned?.map, settings.shortcutOverrides]);
  const current = useRef({ actions, snapshot, paneId, enabled, machineId, compiled });
  current.current = { actions, snapshot, paneId, enabled, machineId, compiled };
  useEffect(() => {
    setPrefixActive(false);
    if (!compiled || !enabled || paneId === null) return;
    let prefixUntil = 0;
    let composing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { prefixUntil = 0; clearTimeout(timer); setPrefixActive(false); };
    const onCompositionStart = () => { composing = true; cancel(); };
    const onCompositionEnd = () => { composing = false; };
    const onKeyDown = (event: KeyboardEvent) => {
      // AltGraph can be reported as Ctrl+Alt or as an independent modifier.
      if (event.getModifierState("AltGraph")) { cancel(); return; }
      const state = current.current;
      const result = resolveKey(compiled, event, {
        now: Date.now(), prefixUntil,
        enabled: state.enabled && state.compiled === compiled && state.machineId === machineId && state.paneId === paneId,
        inTextField: keepsArrowsForText(event.target)
          || event.target instanceof Element && event.target.closest("input:not(.xterm-helper-textarea), select, [contenteditable]:not([contenteditable='false'])") !== null,
        modalOpen: document.querySelector("[aria-modal='true'], dialog[open], [role='menu']") !== null,
        composing,
      });
      if (result.kind === "ignore") return;
      cancel();
      if (result.kind === "pass") return;
      event.preventDefault();
      // Imported keys are never encoded again by xterm or a target's native key handler.
      event.stopImmediatePropagation();
      if (result.kind === "prefix") {
        prefixUntil = Date.now() + PREFIX_TIMEOUT_MS;
        setPrefixActive(true);
        timer = setTimeout(cancel, PREFIX_TIMEOUT_MS);
      } else if (result.kind === "action" && state.snapshot && state.paneId) {
        runHerdrAction(result.target, state.actions, { snapshot: state.snapshot, paneId: state.paneId });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("focusin", cancel, true);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("focusin", cancel, true);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [compiled, enabled, paneId, machineId]);
  return <HerdrKeymapContext.Provider value={{ compiled, error: owned?.error ?? null, prefixActive, reload }}>{children}</HerdrKeymapContext.Provider>;
}
