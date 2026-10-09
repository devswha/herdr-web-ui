import { useHerdrKeymap } from "../lib/herdrKeymapContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import type { BindingStatus } from "../lib/key-engine.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";

export function HerdrKeymapSettings() {
  const { settings, update } = useSettings();
  const { compiled, error, reload } = useHerdrKeymap();
  const t = useT();
  const status = (value: BindingStatus): string => {
    switch (value) {
      case "active": return t("Active outside text fields");
      case "disabled": return t("Off");
      case "unsupported": return t("Not supported in the web UI");
      case "invalid": return t("Unsupported key syntax");
      case "protected": return t("Reserved for the browser, system, or web shortcuts");
      case "duplicate": return t("Already assigned");
      case "prefix-unavailable": return t("No usable prefix sequence");
    }
  };
  return (
    <SettingsGroup title={t("Herdr key bindings")} note={t("Import the selected PC's [keys] and prefix on this device. Web shortcuts, text editing, IME, and clipboard keys keep priority. Shell commands and terminal-only actions are not imported.")}>
      <SettingsRow label={t("Import Herdr key bindings")} description={t("Off by default. Browser-reserved keys such as Cmd+T are not available, including after a prefix.")}>
        <Toggle label={t("Import Herdr key bindings")} checked={settings.importHerdrKeys} onChange={(importHerdrKeys) => update({ importHerdrKeys })} />
      </SettingsRow>
      {settings.importHerdrKeys && <>
        <SettingsRow label={t("Selected PC keymap")} description={t("After editing config.toml on this PC, reload the bindings. Unlisted OS shortcuts may still be intercepted.")}>
          <button type="button" className="btn" onClick={reload}>{t("Reload bindings")}</button>
        </SettingsRow>
        {error ? <div className="error-state" role="alert">{error}</div>
          : compiled === null ? <SettingsRow label={t("Loading key bindings")}><span role="status">{t("Loading…")}</span></SettingsRow>
          : compiled.report.map((binding, index) => (
            <SettingsRow key={index} label={binding.action} description={status(binding.status)} wide>
              <span className="settings-description">{binding.keys || t("Off")}</span>
            </SettingsRow>
          ))}
      </>}
    </SettingsGroup>
  );
}

export function HerdrKeymapNotice() {
  const { prefixActive } = useHerdrKeymap();
  const t = useT();
  return prefixActive ? <span className="pill" role="status" title={t("Press a binding within 1.5 seconds; Escape cancels.")}>{t("Herdr prefix")}</span> : null;
}
