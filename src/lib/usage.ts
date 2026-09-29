import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderUsage, UsageProviderId, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { fetchUsage } from "./api.ts";
import { t } from "./i18n.ts";
import { usePageVisible } from "./visibility.ts";

/** The server asks a provider at most every 5 minutes; a minute here only picks that up sooner. */
const POLL_MS = 60_000;
/** from this much used, a limit is near enough to show in the blocked color */
export const HIGH_PERCENT = 80;

export const PROVIDER_NAME: Readonly<Record<UsageProviderId, string>> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "Copilot", grok: "Grok", antigravity: "Antigravity",
};

/** AgentMark's name for each provider's logo */
export const PROVIDER_MARK: Readonly<Record<UsageProviderId, string>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", antigravity: "agy",
};

export const WINDOW_LABEL: Readonly<Record<UsageWindow["kind"], string>> = {
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** The limit closest to running out: the one a glance at the sidebar has to show. */
export function tightestWindow(usage: ProviderUsage): UsageWindow | null {
  return usage.windows.reduce<UsageWindow | null>((tightest, window) => tightest === null || window.used_percent > tightest.used_percent ? window : tightest, null);
}

export function windowLabel(window: UsageWindow): string {
  const kind = t(WINDOW_LABEL[window.kind]);
  if (window.scope === null) return kind;
  const scope = window.scope === "Other models" ? t("Other models") : window.scope === "Cursor models" ? t("Cursor models") : window.scope;
  return `${kind} · ${scope}`;
}

/** "2d 4h", "3h 12m", "12m" until a reset; null when it is unknown or already past. */
export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("{m}m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{h}h {m}m", { h: hours, m: minutes % 60 });
  return t("{d}d {h}h", { d: Math.floor(hours / 24), h: hours % 24 });
}

/** Percent as the meters print it: whole numbers, except the tenth that keeps a sliver above 0 visible. */
export function formatPercent(value: number): string {
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** A provider with a limit near its end comes first, then the rest in the server's order. */
export function orderProviders(providers: readonly ProviderUsage[]): ProviderUsage[] {
  return [...providers].sort((a, b) => (tightestWindow(b)?.used_percent ?? -1) - (tightestWindow(a)?.used_percent ?? -1));
}

export function useUsage(enabled: boolean) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const visible = usePageVisible();
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await fetchUsage(refresh);
      if (current === generation.current) setReport((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    } catch { /* offline or restarting: the last report stays */ }
    finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) { generation.current++; setReport(null); setLoading(false); return; }
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, visible, load]);

  const refresh = useCallback(() => void load(true), [load]);
  return { report, loading, refresh };
}
