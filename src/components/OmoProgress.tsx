import type { ComponentType } from "react";
import { ChevronRight, Circle, CircleCheck, CircleDot, CircleSlash, ListChecks, Minimize2, RefreshCw, type LucideProps } from "lucide-react";
import type { AgentStatus, OmoProgress as Progress, OmoTodo } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import "./OmoProgress.css";

const ICONS: Record<OmoTodo["status"], ComponentType<LucideProps>> = {
  pending: Circle, in_progress: CircleDot, completed: CircleCheck, abandoned: CircleSlash,
};

/** Kept separate from polling so every live/stale state renders through the same surface. */
export function OmoProgressView({ progress, state, connected, ended, agentStatus }: {
  progress: Progress | null;
  state: "loading" | "ready" | "failed";
  connected: boolean;
  ended: boolean;
  agentStatus?: AgentStatus;
}) {
  const t = useT();
  const live = connected && !ended && state === "ready";
  const activity = live ? progress?.activity ?? "unknown" : "unknown";
  const title = ended ? t("terminal ended")
    : !connected ? t("reconnecting")
    : state === "loading" ? t("Loading progress…")
    : state === "failed" ? t("Progress unavailable — showing the last checklist")
    : activity === "compacting" ? t("Compacting context…")
    : activity === "retrying" ? t("Retrying model request…")
    : agentStatus === "blocked" ? t("Waiting for input")
    : activity === "working" ? t("Working…")
    : activity === "idle" ? t("Idle")
    : t("Live status unavailable");
  const items = progress?.todos ?? [];
  const done = items.filter((item) => item.status === "completed").length;
  const StatusIcon = activity === "compacting" ? Minimize2 : activity === "retrying" ? RefreshCw : ListChecks;
  const words: Record<OmoTodo["status"], string> = {
    pending: t("waiting"), in_progress: t("running"), completed: t("done"), abandoned: t("skipped"),
  };
  const groups: { phase: string; items: OmoTodo[] }[] = [];
  for (const item of items) {
    const group = groups.at(-1);
    if (group?.phase === item.phase) group.items.push(item);
    else groups.push({ phase: item.phase, items: [item] });
  }

  return <section className={`omo-progress is-${activity}`} data-state={state} aria-label={t("OmO progress")}>
    <details>
      <summary>
        <ChevronRight className="omo-progress-chevron" aria-hidden="true" />
        <StatusIcon aria-hidden="true" />
        <span>{t("OmO progress")}</span>
        <span className="omo-progress-status" role="status">{title}</span>
        {items.length > 0 && <span className="omo-progress-count">{t("{done} of {total} done", { done, total: items.length })}</span>}
      </summary>
      <div className="omo-progress-list">
        {groups.map((group, index) => <div key={index} className="omo-progress-phase">
          <p>{group.phase}</p>
          <ul>{group.items.map((item, row) => {
            const Icon = ICONS[item.status];
            return <li key={row} className={`is-${item.status}`}>
              <Icon aria-hidden="true" /><span>{item.content}</span><small>{words[item.status]}</small>
            </li>;
          })}</ul>
        </div>)}
        {items.length === 0 && <p className="omo-progress-empty">{t(progress?.todos === null || progress === null ? "No checklist available yet" : "No remaining checklist items")}</p>}
      </div>
    </details>
  </section>;
}
