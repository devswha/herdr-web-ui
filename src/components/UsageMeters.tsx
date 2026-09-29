import { useEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";

import "./UsageMeters.css";

import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { formatPercent, formatResetIn, HIGH_PERCENT, orderProviders, PROVIDER_MARK, PROVIDER_NAME, tightestWindow, useUsage, windowLabel } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";

/** chips the strip beside Settings holds before the rest fold into "+N" */
const MAX_CHIPS = 4;

function level(window: UsageWindow | null): string {
  return window !== null && window.used_percent >= HIGH_PERCENT ? " is-high" : "";
}

function Chip({ usage }: { usage: ProviderUsage }) {
  const window = tightestWindow(usage);
  return (
    <span className={`usage-chip${level(window)}${usage.problem ? " has-problem" : ""}`}>
      <AgentMark agent={PROVIDER_MARK[usage.id]} size={14} />
      <span className="usage-chip-value">{window ? formatPercent(window.used_percent) : "—"}</span>
      <span className="usage-chip-bar" style={{ "--used": `${window?.used_percent ?? 0}%` } as CSSProperties} />
    </span>
  );
}

function Provider({ usage, now }: { usage: ProviderUsage; now: number }) {
  const t = useT();
  const name = PROVIDER_NAME[usage.id];
  const problem = usage.problem === "expired" ? t("Sign-in expired. Open {name} to renew it.", { name })
    : usage.problem === "rate_limited" ? t("{name} asked to slow down. These are the last numbers.", { name })
    : usage.problem === "failed" ? t("{name} could not be reached.", { name })
    : usage.problem === "locked" ? t("The server cannot open the keychain holding this sign-in.")
    : null;
  return (
    <section className="usage-provider" aria-label={name}>
      <header className="usage-provider-head">
        <AgentMark agent={PROVIDER_MARK[usage.id]} size={16} />
        <span className="usage-provider-name">{name}</span>
        {usage.plan && <span className="usage-plan">{usage.plan}</span>}
      </header>
      {problem && <p className={`usage-note${usage.problem === "expired" || usage.problem === "failed" ? " is-problem" : ""}`}>{problem}</p>}
      {usage.windows.map((window, index) => {
        const reset = formatResetIn(window.resets_at, now);
        return (
          <div key={index} className={`usage-row${level(window)}`}>
            <span className="usage-row-label">{windowLabel(window)}</span>
            {reset && <span className="usage-row-reset">{t("Resets in {time}", { time: reset })}</span>}
            <span className="usage-row-value">{formatPercent(window.used_percent)}</span>
            <span className="usage-bar" role="meter" aria-label={windowLabel(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.used_percent}>
              {/* a sliver above 0 still shows as a bar, not a dot */}
              <span style={{ width: window.used_percent > 0 ? `max(4px, ${window.used_percent}%)` : 0 }} />
            </span>
          </div>
        );
      })}
      {usage.windows.length === 0 && !problem && <p className="usage-note">{t("No limits reported")}</p>}
    </section>
  );
}

/**
 * The plan limits of the subscriptions signed in on the server's PC, beside Settings: per
 * provider its logo and the limit closest to running out; the whole strip opens every limit
 * with its reset time.
 */
export function UsageMeters() {
  const t = useT();
  const { settings } = useSettings();
  const { report, loading, refresh } = useUsage(settings.showUsage);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Escape and focus belong to the meters only while focus is in them: other dialogs keep theirs
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    stripRef.current?.focus();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  const providers = report ? orderProviders(report.providers) : [];
  if (!settings.showUsage || providers.length === 0) return null;
  const folded = providers.length > MAX_CHIPS ? providers.length - (MAX_CHIPS - 1) : 0;
  const chips = folded > 0 ? providers.slice(0, MAX_CHIPS - 1) : providers;
  const summary = providers.map((usage) => {
    const window = tightestWindow(usage);
    return `${PROVIDER_NAME[usage.id]} ${window ? formatPercent(window.used_percent) : "—"}`;
  }).join(", ");

  return (
    <div className="usage" ref={rootRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={stripRef}
        type="button"
        className="usage-strip"
        aria-expanded={open}
        aria-label={`${t("Subscription usage")}: ${summary}`}
        title={summary}
        onClick={() => setOpen(!open)}
      >
        {chips.map((usage) => <Chip key={usage.id} usage={usage} />)}
        {folded > 0 && <span className="usage-more">+{folded}</span>}
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label={t("Subscription usage")}>
          <header className="usage-popover-head">
            <span>{t("Subscription usage")}</span>
            {/* busy, not disabled: a disabled button drops focus, and Escape with it */}
            <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} aria-busy={loading} onClick={() => { if (!loading) refresh(); }}>
              <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : undefined} />
            </button>
          </header>
          {providers.map((usage) => <Provider key={usage.id} usage={usage} now={now} />)}
        </div>
      )}
    </div>
  );
}
