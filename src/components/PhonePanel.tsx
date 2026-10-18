import "./PhonePanel.css";
import type { PhonePlan } from "../lib/phone.ts";
import { QrCode } from "./QrCode.tsx";
import { useT } from "../lib/i18n.ts";
import { DISTRIBUTION_URL } from "../../shared/distribution.ts";

/** A separately configured HTTPS address can be shared without discovering or publishing routes. */
export function PhonePanel({ plan }: { plan: PhonePlan }) {
  const t = useT();
  return <div className="phone-panel">{plan.kind === "here" ? <>
    <Address url={plan.url} title={t("Open this address on your phone")} />
    <p className="settings-description">{t("Once it is open, install the app, then open the ⋯ menu and tap Alerts.")}</p>
  </> : <p className="settings-description">
    {t("Use your own HTTPS reverse proxy or an SSH tunnel, then pair this device.")} <a href={`${DISTRIBUTION_URL}/blob/main/docs/guide.md#on-your-phone`} target="_blank" rel="noreferrer">{t("Other routes")}</a>
  </p>}</div>;
}

export function Address({ url, title }: { url: string; title: string }) {
  return (
    <div className="phone-address">
      <QrCode value={url} label={`QR code: ${url}`} />
      <div>
        <p className="settings-label">{title}</p>
        <p className="phone-url"><a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      </div>
    </div>
  );
}
