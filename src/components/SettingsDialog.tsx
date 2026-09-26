import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, Star, X } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { SHORTCUTS, formatKeys } from "../lib/shortcuts.ts";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, useSettings } from "../lib/settings.ts";
import { LANGUAGE_NAMES, useT, type LanguageSetting } from "../lib/i18n.ts";
import type { UpdatesModel } from "../lib/updates.ts";
import type { MachineSettings } from "../../shared/machines.ts";
import { fetchRemoteAccess, machineRequest } from "../lib/api.ts";
import { isLoopbackHost, phonePlan } from "../lib/phone.ts";
import type { HealthAuth, RemoteAccess } from "../../shared/protocol.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { UpdateControls } from "./UpdateControls.tsx";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  actions: AppActions;
  updates: UpdatesModel;
  /** how this browser got in, from the last health check */
  auth: HealthAuth | null;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button type="button" className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsDialog({ open, onClose, updates, auth }: SettingsDialogProps) {
  const { settings, update } = useSettings();
  const t = useT();
  const installPrompt = useInstallPrompt();
  const firstControlRef = useRef<HTMLButtonElement>(null);
  // server-side: the web server updates PC bridges, so it keeps this choice
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    machineRequest<MachineSettings>("/settings").then(setPcSettings, () => setPcSettings(null));
  }, [open]);
  // Settings → Phone asks the server what Tailscale on its PC already serves
  const [access, setAccess] = useState<RemoteAccess | null | undefined>(undefined);
  const loadAccess = useCallback(() => {
    setAccess(undefined);
    fetchRemoteAccess().then(setAccess, () => setAccess(null));
  }, []);
  useEffect(() => { if (open) loadAccess(); }, [open, loadAccess]);
  const plan = phonePlan({ protocol: window.location.protocol, hostname: window.location.hostname, origin: window.location.origin, secure: window.isSecureContext }, access ?? null);
  // where a phone can open this app now, for the pairing QR code: the served address, else this one when it is not loopback
  const pairUrl = plan.kind === "here" || plan.kind === "served" ? plan.url : isLoopbackHost(window.location.hostname) ? null : window.location.origin;

  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    if (!open) return;
    firstControlRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-header">
          <h2 className="modal-title" id="settings-title">{t("Settings")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} onClick={onClose}><X /></button>
        </header>
        <div className="modal-body settings-body">
          <section className="settings-section">
            <h3>{t("Appearance")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Theme")}</span><span className="settings-description">{t("Choose the app color scheme")}</span></div>
              <div className="segmented" aria-label={t("Theme")}>
                {(["dark", "light", "system"] as const).map((theme, index) => (
                  <button key={theme} ref={index === 0 ? firstControlRef : undefined} type="button" aria-pressed={settings.theme === theme} onClick={() => update({ theme })}>
                    {t(theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Density")}</span><span className="settings-description">{t("Adjust spacing throughout the interface")}</span></div>
              <div className="segmented" aria-label={t("Density")}>
                {(["comfortable", "compact"] as const).map((density) => (
                  <button key={density} type="button" aria-pressed={settings.density === density} onClick={() => update({ density })}>
                    {t(density === "compact" ? "Compact" : "Comfortable")}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Language")}</span><span className="settings-description">{t("Follows the browser unless you choose one")}</span></div>
              <div className="segmented" aria-label={t("Language")}>
                {(["system", "en", "ko"] as const satisfies readonly LanguageSetting[]).map((language) => (
                  <button key={language} type="button" aria-pressed={settings.language === language} onClick={() => update({ language })}>
                    {language === "system" ? t("System") : LANGUAGE_NAMES[language]}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Terminal font size")}</span><span className="settings-description">{t("Applied to every terminal pane")}</span></div>
              <div className="settings-stepper" aria-label={t("Terminal font size")}>
                <button type="button" className="icon-button" aria-label={t("Decrease terminal font size")} disabled={settings.terminalFontSize <= TERMINAL_FONT_MIN} onClick={() => update({ terminalFontSize: settings.terminalFontSize - 1 })}><Minus /></button>
                <output aria-live="polite">{settings.terminalFontSize}px</output>
                <button type="button" className="icon-button" aria-label={t("Increase terminal font size")} disabled={settings.terminalFontSize >= TERMINAL_FONT_MAX} onClick={() => update({ terminalFontSize: settings.terminalFontSize + 1 })}><Plus /></button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Composer")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Enter sends")}</span><span className="settings-description">{t("When off, Mod+Enter sends")}</span></div>
              <Toggle label={t("Enter sends")} checked={settings.enterSends} onChange={(enterSends) => update({ enterSends })} />
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Chat")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Show thinking")}</span><span className="settings-description">{t("Include the agent's reasoning blocks")}</span></div>
              <Toggle label={t("Show thinking")} checked={settings.showThinking} onChange={(showThinking) => update({ showThinking })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Chat font size")}</span><span className="settings-description">{t("Messages, code and prompt cards in the chat view")}</span></div>
              <div className="settings-stepper" aria-label={t("Chat font size")}>
                <button type="button" className="icon-button" aria-label={t("Decrease chat font size")} disabled={chatFontSize(settings) <= CHAT_FONT_MIN} onClick={() => update({ chatFontSize: chatFontSize(settings) - 1 })}><Minus /></button>
                <output aria-live="polite">{chatFontSize(settings)}px</output>
                <button type="button" className="icon-button" aria-label={t("Increase chat font size")} disabled={chatFontSize(settings) >= CHAT_FONT_MAX} onClick={() => update({ chatFontSize: chatFontSize(settings) + 1 })}><Plus /></button>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Alerts")}</h3>
            <p className="settings-description">{t("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.")}</p>
            <div className="settings-row">
              <div><span className="settings-label">{t("Needs input")}</span><span className="settings-description">{t("An agent waits for an answer or a permission")}</span></div>
              <Toggle label={t("Needs input")} checked={settings.alertInput} onChange={(alertInput) => update({ alertInput })} />
            </div>
            <div className="settings-row">
              <div><span className="settings-label">{t("Finished")}</span><span className="settings-description">{t("Long turns: only work that took a minute or more")}</span></div>
              <div className="segmented" aria-label={t("Finished")}>
                {(["off", "long", "always"] as const).map((alertDone) => (
                  <button key={alertDone} type="button" aria-pressed={settings.alertDone === alertDone} onClick={() => update({ alertDone })}>
                    {t(alertDone === "off" ? "Off" : alertDone === "long" ? "Long turns" : "Every turn")}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t("Shortcuts")}</h3>
            <table className="settings-shortcuts">
              <tbody>{SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.id}><th scope="row">{t(shortcut.label)}</th><td>{formatKeys(shortcut.keys).map((key) => <kbd className="kbd" key={key}>{key}</kbd>)}</td></tr>
              ))}</tbody>
            </table>
          </section>

          <section className="settings-section">
            <h3>{t("Phone")}</h3>
            <PhonePanel plan={plan} loading={access === undefined} onRefresh={loadAccess} />
          </section>

          <section className="settings-section">
            <h3>{t("Devices")}</h3>
            <DevicesPanel pairUrl={pairUrl} auth={auth} />
          </section>

          <section className="settings-section">
            <h3>{t("Install")}</h3>
            {installPrompt.installed ? <p className="settings-hint">{t("Installed")}</p> : installPrompt.canInstall ? (
              <button type="button" className="btn btn-primary" onClick={() => void installPrompt.install()}>{t("Install app")}</button>
            ) : <p className="settings-hint">{installPrompt.help}</p>}
          </section>

          <section className="settings-section settings-about">
            <h3>{t("About")}</h3>
            <p><strong>herdr web ui</strong></p>
            <a className="btn" href="https://github.com/devswha/herdr-web-ui" target="_blank" rel="noreferrer"><Star aria-hidden="true" />{t("Star on GitHub")}</a>
            <a href="https://devswha.github.io/herdr-web-ui/" target="_blank" rel="noreferrer">devswha.github.io/herdr-web-ui</a>
          </section>
          {pcSettings && <section className="settings-section">
            <h3>{t("Remote PCs")}</h3>
            <div className="settings-row">
              <div><span className="settings-label">{t("Update PC bridges automatically")}</span><span className="settings-description">{t("When an app update needs a newer bridge, PCs that connect with their saved key are updated in the background. PCs that need a password ask first.")}</span></div>
              <Toggle label={t("Update PC bridges automatically")} checked={pcSettings.auto_update_bridges} onChange={(auto_update_bridges) => void updatePcSettings({ auto_update_bridges })} />
            </div>
            {pcSettingsError && <p className="settings-hint" role="alert">{pcSettingsError}</p>}
          </section>}

          <UpdateControls updates={updates} bridgesFollow={pcSettings?.auto_update_bridges === true} />
        </div>
      </section>
    </div>
  );
}
