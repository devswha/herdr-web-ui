import type { UpdatesModel } from "../lib/updates.ts";
import "./UpdateControls.css";
import { useT } from "../lib/i18n.ts";

/** "v0.2.0 (1c4ad6a0e502)" when the version is known, else the commit alone. */
function versionLabel(version: string | null | undefined, revision: string | null | undefined): string | null {
  const commit = revision?.slice(0, 12);
  if (version) return commit ? `v${version} (${commit})` : `v${version}`;
  return commit ?? null;
}

export function UpdateControls({ updates, bridgesFollow = false }: { updates: UpdatesModel; bridgesFollow?: boolean }) {
  const t = useT();
  const { status, error, busy, needsReload, request } = updates;
  return <section className="settings-section settings-updates">
    <h3>{t("Updates")}</h3>
    <p className="settings-hint">{status?.current_revision ? t("Running {version}", { version: versionLabel(status.current_version, status.current_revision) ?? "" }) : "herdr web ui"}</p>
    <p className="settings-hint" role="status">
      {error ?? status?.error ?? status?.blocked_reason ?? (busy ?
        status?.phase === "building" ? t("Installing dependencies and building…") : status?.phase === "restarting" ? t("Restarting the bridge…") : t("Checking for updates…") :
        status?.available ? t("Version {version} is available.", { version: versionLabel(status.latest_version, status.latest_revision) ?? "" }) : status?.checked_at ? t("Up to date.") : t("Waiting for an update check…"))}
    </p>
    {status?.managed && <>
      <p className="settings-hint">{t("Checks for new releases every 5 minutes.")} {t(status.auto_update ? "Automatic installation is enabled." : "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running.")}{bridgesFollow ? ` ${t("Remote PCs' bridges are updated afterwards when the new version needs it.")}` : ""}</p>
      <div className="update-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void request("check")}>{t("Check for updates")}</button>
        <button type="button" className="btn btn-primary" disabled={busy || !status.available || !!status.blocked_reason} onClick={() => void request("install")}>{t("Update and restart")}</button>
      </div>
    </>}
    {status?.checked_at && <p className="settings-hint">Last checked {new Date(status.checked_at).toLocaleString()}</p>}
    {needsReload && <p className="settings-hint">{t("The server was updated. Save any unsent drafts, then")} <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button></p>}
  </section>;
}

export function UpdateNotice({ updates, onOpen }: { updates: UpdatesModel; onOpen: () => void }) {
  const t = useT();
  const { status, needsReload } = updates;
  if (!needsReload && !status?.available && status?.phase !== "building" && status?.phase !== "restarting") return null;
  return <div className="update-notice" role="status">
    <span>{needsReload ? t("App updated. Save unsent drafts before reloading.") : status?.phase === "building" ? t("Preparing the update…") : status?.phase === "restarting" ? t("Updating; reconnecting shortly…") : status?.latest_version ? t("herdr web ui v{version} is available.", { version: status.latest_version }) : t("A herdr web ui update is available.")}</span>
    <button type="button" className="btn" onClick={needsReload ? () => window.location.reload() : onOpen}>{t(needsReload ? "Reload app" : "View update")}</button>
  </div>;
}
