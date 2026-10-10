import { useState } from "react";

import "./PortalPanel.css";
import "./UpdateControls.css";

import { useT } from "../lib/i18n.ts";
import { PORTAL_SETTLING, usePortal } from "../lib/portal.ts";
import { Address } from "./PhonePanel.tsx";
import { SettingsGroup } from "./SettingsControls.tsx";

/**
 * Settings → Phone & devices → Portal: a public HTTPS address for this PC through a relay the
 * user picks. Only this PC itself installs or starts it (the server decides who that is); any
 * signed-in device sees the address, and one that can type takes it down. Hidden where the server
 * offers none.
 */
export function PortalPanel() {
  const t = useT();
  const { status, error, pending, request } = usePortal();
  // what was typed; until then, the relay this PC used last
  const [typed, setTyped] = useState<string | null>(null);
  if (!status?.supported) return null;
  const relay = typed ?? status.relay ?? "";
  const busy = pending || PORTAL_SETTLING.has(status.phase);
  const on = status.phase === "running" || status.phase === "starting";
  const progress = status.phase === "installing" ? t("Installing Portal…") : status.phase === "starting" ? t("Starting…") : status.phase === "stopping" ? t("Stopping…") : null;
  let controls;
  if (on) {
    controls = <div className="phone-actions"><button type="button" className="btn" disabled={pending} onClick={() => void request("stop")}>{t("Stop")}</button></div>;
  } else if (status.blocked !== null) {
    controls = <p className="settings-hint">{status.blocked === "token_required" ? t("Set HERDR_WEB_TOKEN on this PC first: anyone on the internet can open a Portal address.") : t("Portal is a second way in, so turn HERDR_WEB_TAILSCALE_SERVE_ONLY off first.")}</p>;
  } else if (!status.here) {
    controls = <p className="settings-hint">{t("Only this PC itself can install or start Portal.")}</p>;
  } else if (!status.usable) {
    controls = (
      <>
        <p className="settings-description">{status.version === null ? t("Portal is not installed on this PC.") : t("This PC has Portal {version}; the app needs {min} or later.", { version: status.version, min: status.min_version })}</p>
        <div className="phone-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void request("install")}>{t("Install Portal {version}", { version: status.min_version })}</button></div>
      </>
    );
  } else {
    controls = (
      <form className="portal-start" onSubmit={(event) => { event.preventDefault(); void request("start", relay); }}>
        <label className="settings-label" htmlFor="portal-relay">{t("Relay")}</label>
        <span className="settings-description">{t("A Portal relay you trust, on {min} or later (portal list shows them). It holds the certificate for the address, so a relay set up to intercept could read the traffic.", { min: status.min_version })}</span>
        <div className="phone-actions">
          <input id="portal-relay" className="input" inputMode="url" value={relay} placeholder="https://relay.example.com" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} onChange={(event) => setTyped(event.currentTarget.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy || relay.trim() === ""}>{t("Start")}</button>
        </div>
      </form>
    );
  }
  return (
    <SettingsGroup title="Portal" note={t("A public HTTPS address with no account and no domain of your own. Anyone on the internet can open it, so the access token is required.")}>
      <div className="settings-item"><div className="phone-panel">
        {status.url !== null && <Address url={status.url} title={t("Portal serves this PC")} />}
        {controls}
        {(error ?? progress) !== null && <p className="settings-hint" role="status">{error ?? progress}</p>}
        {/* the server's account of the last failure, then Portal's own words */}
        {status.phase === "error" && status.error !== null && <p className="settings-hint" role="alert">{status.error}</p>}
        {status.phase === "error" && status.output !== null && <pre className="update-output" data-failed>{status.output}</pre>}
      </div></div>
    </SettingsGroup>
  );
}
