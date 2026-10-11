import { useRef, useState } from "react";
import { Ban, RotateCcw } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { formatKeys, isMacPlatform, shortcutConflict, shortcutDisplayKeys, shortcutKeys, type ShortcutId } from "../lib/shortcuts.ts";
import { isReservedShortcutBinding, manualShortcutBinding, recordShortcutBinding, resolveShortcutBinding, type ShortcutBinding, type ShortcutSpec } from "../lib/shortcutBindings.ts";
import "./ShortcutRecorder.css";

const MANUAL_KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789,", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "Insert", ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`)];
const compactKeys = (keys: readonly string[]) => formatKeys(keys).map((key) => ({ Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] ?? key)).join("+");

export function ShortcutRecorder({ id, label }: { id: ShortcutId; label: string }) {
  const { settings, update } = useSettings();
  const t = useT();
  const recordButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<ShortcutBinding | null>(null);
  const [modifiers, setModifiers] = useState(() => resolveShortcutBinding("", isMacPlatform()));
  const [manualKey, setManualKey] = useState("");
  const [customKey, setCustomKey] = useState(false);
  const [notice, setNotice] = useState(false);
  const currentKeys = shortcutDisplayKeys(id, settings.shortcutOverrides);
  const currentSpec = shortcutKeys(id, settings.shortcutOverrides)[0];
  const currentBinding = currentSpec ? resolveShortcutBinding(currentSpec, isMacPlatform()) : null;
  const previewKeys = candidate ? shortcutDisplayKeys(id, { [id]: candidate }) : [];
  const conflict = candidate !== null && shortcutConflict(id, [candidate], settings.shortcutOverrides);
  const shownBinding = editing ? candidate : currentBinding;
  const shownKeys = editing ? previewKeys : currentKeys;
  const reserved = shownBinding !== null && isReservedShortcutBinding(shownBinding, isMacPlatform());
  const exactOverride = editing || (typeof settings.shortcutOverrides[id] === "object" && settings.shortcutOverrides[id] !== null);
  const overridesInput = exactOverride && shownBinding !== null && (shownBinding.ctrlKey || (!shownBinding.metaKey && !shownBinding.altKey));
  const finish = () => {
    setEditing(false); setRecording(false); setNotice(false);
    recordButton.current?.focus({ preventScroll: true });
  };
  const persist = (value: ShortcutSpec | null | undefined) => {
    const next = { ...settings.shortcutOverrides };
    if (value === undefined) delete next[id];
    else next[id] = value;
    update({ shortcutOverrides: next });
    finish();
  };
  const begin = (capture: boolean) => {
    setCandidate(currentBinding);
    setModifiers(currentBinding ?? resolveShortcutBinding("", isMacPlatform()));
    setManualKey(currentBinding?.key ?? "");
    setCustomKey(!currentBinding || !MANUAL_KEYS.includes(currentBinding.key));
    setEditing(true); setRecording(capture); setNotice(false);
    if (capture) recordButton.current?.focus({ preventScroll: true });
  };
  const setManual = (key: string, nextModifiers = modifiers) => {
    setManualKey(key);
    setModifiers(nextModifiers);
    setCandidate(manualShortcutBinding(key, nextModifiers));
    setNotice(false);
  };
  return (
    <div className="shortcut-recorder" role="group" aria-label={label} data-shortcut-recording={editing ? "" : undefined} onKeyDown={(event) => {
      if (editing && event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); finish(); }
    }}>
      <div className="shortcut-recorder-controls">
        <button ref={recordButton} type="button" className="btn shortcut-recorder-record" aria-label={t("Record shortcut for {action}", { action: label })} aria-pressed={recording}
          onClick={() => recording ? setRecording(false) : begin(true)} onBlur={() => setRecording(false)} onKeyDownCapture={(event) => {
            if (!recording || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || ["Meta", "Control", "Shift", "Alt", "Dead", "Unidentified", "Process"].includes(event.key)) return;
            const bare = !event.metaKey && !event.ctrlKey && !event.altKey;
            if (event.key === "Escape" && bare && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); finish(); return; }
            if (event.key === "Tab" && bare) { setRecording(false); return; }
            event.preventDefault(); event.stopPropagation();
            if (event.repeat) return;
            const value = recordShortcutBinding(event.nativeEvent);
            if (!value) { setNotice(true); return; }
            setCandidate(value); setModifiers(value); setManualKey(value.key); setCustomKey(!MANUAL_KEYS.includes(value.key)); setRecording(false); setNotice(false);
          }}>{recording ? t("Press keys…") : currentKeys.length ? compactKeys(currentKeys) : t("Off")}</button>
        <button type="button" className="btn" aria-label={t("Edit shortcut for {action}", { action: label })} onClick={() => begin(false)}>{t("Edit")}</button>
        <button type="button" className="icon-button" aria-label={t("Restore default shortcut for {action}", { action: label })} title={t("Restore default shortcut for {action}", { action: label })} disabled={!Object.hasOwn(settings.shortcutOverrides, id) || shortcutConflict(id, shortcutKeys(id, {}), settings.shortcutOverrides)} onClick={() => persist(undefined)}><RotateCcw aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("Disable shortcut for {action}", { action: label })} title={t("Disable shortcut for {action}", { action: label })} disabled={settings.shortcutOverrides[id] === null} onClick={() => persist(null)}><Ban aria-hidden="true" /></button>
      </div>
      {editing && <div className="shortcut-recorder-editor">
        <span className="settings-description" role="status">{t("Shortcut preview")}: {previewKeys.length ? compactKeys(previewKeys) : t("Choose a key")}</span>
        <div className="shortcut-recorder-modifiers">
          {(["ctrlKey", "metaKey", "altKey", "shiftKey"] as const).map((modifier, index) => <label key={modifier}><input type="checkbox" checked={modifiers[modifier]} onChange={(event) => setManual(manualKey, { ...modifiers, [modifier]: event.target.checked })} />{formatKeys([ ["Ctrl", "Meta", "Alt", "Shift"][index]! ])[0]}</label>)}
        </div>
        <label className="shortcut-recorder-key">{t("Shortcut key")}
          <select className="select" aria-label={t("Shortcut key")} value={customKey ? "custom" : manualKey} onChange={(event) => { setCustomKey(event.target.value === "custom"); setManual(event.target.value === "custom" ? "" : event.target.value); }}>
            <option value="custom">{t("Custom key")}</option>
            {MANUAL_KEYS.map((key) => <option key={key} value={key}>{key.length === 1 ? key.toUpperCase() : key}</option>)}
          </select>
        </label>
        {customKey && <label className="shortcut-recorder-key">{t("Type a character or key name")}
          <input className="input" value={manualKey} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setManual(event.target.value)} />
        </label>}
        {customKey && !candidate && manualKey && <span className="settings-description" role="status">{t("Use a Latin letter, digit, comma, or named key. Record other characters with your keyboard.")}</span>}
        {conflict && <span className="settings-description" role="status">{t("Already assigned")}</span>}
        {notice && <span className="settings-description" role="status">{t("Press a key with the modifiers you want.")}</span>}
        <div className="shortcut-recorder-controls">
          <button type="button" className="btn btn-primary" disabled={!candidate || conflict || recording} onClick={() => candidate && persist(candidate)}>{t("Save")}</button>
          <button type="button" className="btn" onClick={finish}>{t("Cancel")}</button>
        </div>
      </div>}
      {reserved && <span className="settings-description">{t("Your browser or operating system may intercept {keys}.", { keys: compactKeys(shownKeys) })}</span>}
      {overridesInput && <span className="settings-description">{t("This binding can override text editing or terminal keys.")}</span>}
    </div>
  );
}
