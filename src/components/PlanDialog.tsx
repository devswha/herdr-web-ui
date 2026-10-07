import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type RefObject } from "react";
import { Circle, CircleCheck, CircleDot, ListChecks, Workflow, X, type LucideProps } from "lucide-react";

import "./PlanDialog.css";

import { formatTokens } from "../lib/compose.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { clockOffsetMs, formatElapsed, spanMs } from "../lib/omoTasks.ts";
import { FLOW, flowLayout, planWaves } from "../lib/plan.ts";
import { useT } from "../lib/i18n.ts";
import type { OmoTask, PlanActivity, PlanStep, PlanSummary } from "../../shared/protocol.ts";

const POLL_MS = 3000;
/** the detail of what was done while no step ran; no step has this id */
const OUTSIDE = "\0outside";

const ICONS: Record<PlanStep["status"], ComponentType<LucideProps>> = { pending: Circle, in_progress: CircleDot, completed: CircleCheck };

/** The header's way to the selected pane's plan, in the chat and the terminal alike: how far it has got. */
export function PlanButton({ plan, onOpen }: { plan: PlanSummary; onOpen: () => void }) {
  const t = useT();
  const label = t("Plan: {done} of {total} done", { done: plan.done, total: plan.total });
  return (
    <button type="button" className={`plan-button${plan.done === plan.total ? " is-done" : ""}`} aria-haspopup="dialog" aria-label={label} title={plan.current ? `${label} · ${plan.current}` : label} onClick={onOpen}>
      <ListChecks aria-hidden="true" />
      <span className="plan-button-count">{plan.done}/{plan.total}</span>
    </button>
  );
}

/**
 * The plan the pane's agent keeps (Claude Code's task list, Codex's checklist), as a flow of
 * boxes (a step below the steps it waits on) or as a list; a step picked shows what was done while
 * it ran. Read again every few seconds while open; times are the PC's.
 */
export function PlanDialog({ paneId, title, onClose }: { paneId: string; title: string; onClose: () => void }) {
  const t = useT();
  const { fetchPanePlan } = useMachineApi();
  const titleId = useId();
  const detailId = useId();
  /** undefined: not read yet; null: the pane keeps no plan */
  const [steps, setSteps] = useState<PlanStep[] | null | undefined>(undefined);
  const [outside, setOutside] = useState<PlanActivity | null>(null);
  const [failed, setFailed] = useState(false);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** null: not picked, so a plan whose steps wait on none (nothing to draw) opens as the list */
  const [picked, setView] = useState<"flow" | "steps" | null>(null);
  const view = picked ?? (steps?.some((step) => step.blocked_by.length > 0) ? "flow" : "steps");
  /**
   * The step whose detail is open (or OUTSIDE), by id and name: a Codex step's id is its place in
   * the checklist, so another step there is not the one that was opened.
   */
  const [chosen, setChosen] = useState<{ id: string; label: string } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  /** the box or row that opened the detail: the focus goes back to it when the detail goes */
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSteps(undefined);
    setChosen(null);
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPanePlan(paneId);
        if (!alive) return;
        const received = Date.now();
        setSteps(next.steps); setOutside(next.outside); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        if (alive) setFailed(true);
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [paneId, fetchPanePlan]);

  // a step that runs counts its time up between reads
  const running = steps?.some((step) => step.status === "in_progress") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // the terminal under the dialog may hold the focus: Escape is the dialog's and goes no further
  useLayoutEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [onClose]);

  // the focus comes into the dialog and goes back where it was on close
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => before?.focus();
  }, []);

  const chosenId = chosen?.id ?? null;
  const step = chosen === null || chosen.id === OUTSIDE ? undefined : steps?.find((candidate) => candidate.id === chosen.id && candidate.label === chosen.label);
  const shown = chosen?.id === OUTSIDE ? outside !== null : step !== undefined;
  /** closes the detail; the focus goes back to what opened it, or to the dialog's close button when that is gone too */
  const closeDetail = (): void => {
    const opener = openerRef.current;
    (opener?.isConnected ? opener : closeRef.current)?.focus();
    setChosen(null);
  };
  // a step that left the plan takes its detail with it
  useEffect(() => {
    if (chosen !== null && steps !== undefined && !shown) closeDetail();
  });
  // a detail opened below a long flow is brought into view (a phone shows little at once)
  useEffect(() => {
    if (chosenId !== null) detailRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [chosenId]);

  const words: Record<PlanStep["status"], string> = { pending: t("waiting"), in_progress: t("running"), completed: t("done") };
  /** what one step says under its name: its state, how long it took or has run, who has it */
  const meta = (step: PlanStep): string => {
    const elapsed = spanMs(step.started_at, step.ended_at, step.status === "in_progress", now + offset);
    return [words[step.status], elapsed === null ? null : formatElapsed(elapsed), step.owner].filter((part) => part !== null).join(" · ");
  };
  const done = steps?.filter((step) => step.status === "completed").length ?? 0;
  const current = steps?.find((step) => step.status === "in_progress");
  /** a press opens the step's detail, and a second press on the same one closes it */
  const open = (id: string, label: string, opener: HTMLElement): void => {
    openerRef.current = opener;
    if (chosen?.id === id && chosen.label === label) closeDetail();
    else setChosen({ id, label });
  };
  const calls = (activity: PlanActivity): number => activity.tools.reduce((sum, tool) => sum + tool.count, 0);
  const isOpen = (candidate: PlanStep): boolean => chosen?.id === candidate.id && chosen.label === candidate.label;

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal plan-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 className="modal-title plan-dialog-title" id={titleId}>{t("Plan")} <span className="plan-dialog-pane">{title}</span></h2>
          <div className="segmented plan-view-switch" role="group" aria-label={t("Plan view")}>
            <button type="button" aria-pressed={view === "flow"} onClick={() => setView("flow")}><Workflow aria-hidden="true" />{t("Flow")}</button>
            <button type="button" aria-pressed={view === "steps"} onClick={() => setView("steps")}><ListChecks aria-hidden="true" />{t("Steps")}</button>
          </div>
          <button ref={closeRef} type="button" className="icon-button" aria-label={t("Close plan")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body plan-dialog-body">
          {steps === undefined && !failed && <p className="plan-note" role="status">{t("Reading the plan…")}</p>}
          {steps === null && <p className="plan-note">{t("This session keeps no plan right now. Claude Code's task list and Codex's checklist show here as the agent makes them.")}</p>}
          {failed && <p className="plan-note plan-error" role="status">{t("Couldn't read the plan. Trying again…")}</p>}
          {steps && steps.length > 0 && (
            <>
              <p className="plan-summary">
                {t("{done} of {total} done", { done, total: steps.length })}
                {current && <span className="plan-summary-now">{current.active ?? current.label}</span>}
              </p>
              {view === "flow" ? <PlanFlow steps={steps} meta={meta} label={t("Plan flow")} after={(labels) => t("after {steps}", { steps: labels.join(", ") })} isOpen={isOpen} detailId={detailId} onOpen={open} /> : (
                <ol className="plan-steps">
                  {planWaves(steps).flat().map((step) => {
                    const Icon = ICONS[step.status];
                    return (
                      <li key={step.id} className={`plan-step is-${step.status}${isOpen(step) ? " is-chosen" : ""}`}>
                        <button type="button" className="plan-step-open" aria-expanded={isOpen(step)} aria-controls={isOpen(step) ? detailId : undefined} onClick={(event) => open(step.id, step.label, event.currentTarget)}>
                          <Icon aria-hidden="true" />
                          <span className="plan-step-main">
                            <span className="plan-step-label">{step.label}</span>
                            {step.status === "in_progress" && step.active && step.active !== step.label && <span className="plan-step-active">{step.active}</span>}
                            <span className="plan-step-meta">{meta(step)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {outside !== null && (
                <button type="button" className={`plan-outside${chosenId === OUTSIDE ? " is-chosen" : ""}`} aria-expanded={chosenId === OUTSIDE} aria-controls={chosenId === OUTSIDE ? detailId : undefined} onClick={(event) => open(OUTSIDE, "", event.currentTarget)}>
                  {t(calls(outside) === 1 ? "Work outside the steps · {n} call" : "Work outside the steps · {n} calls", { n: calls(outside) })}
                </button>
              )}
              {shown && (
                <StepDetail
                  boxRef={detailRef}
                  id={detailId}
                  paneId={paneId}
                  label={step?.label ?? t("Outside the steps")}
                  status={step?.status ?? null}
                  meta={step ? meta(step) : null}
                  active={step?.status === "in_progress" && step.active && step.active !== step.label ? step.active : null}
                  activity={step ? step.activity ?? null : outside}
                  now={now + offset}
                  onClose={closeDetail}
                />
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** The plan as boxes: waves top to bottom, a curve from each step to the steps that wait on it. */
function PlanFlow({ steps, meta, label, after, isOpen, detailId, onOpen }: {
  steps: PlanStep[]; meta: (step: PlanStep) => string; label: string; after: (labels: string[]) => string;
  isOpen: (step: PlanStep) => boolean; detailId: string; onOpen: (id: string, label: string, opener: HTMLElement) => void;
}) {
  // two boxes side by side at most on a phone
  const columns = window.matchMedia?.("(max-width: 480px)").matches ? 2 : 4;
  const layout = useMemo(() => flowLayout(steps, columns), [steps, columns]);
  const labelOf = useMemo(() => new Map(steps.map((step) => [step.id, step.label])), [steps]);
  // an id that is also a valid url(#…) reference
  const arrow = `plan-arrow-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <div className="plan-flow-scroll">
      <div className="plan-flow" style={{ width: layout.width, height: layout.height }}>
        <svg className="plan-flow-edges" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {/* an arrowhead takes no color from its line: one per kind of line */}
            {["wait", "done"].map((kind) => (
              <marker key={kind} id={`${arrow}-${kind}`} className={`plan-arrow is-${kind}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => <path key={`${edge.from}>${edge.to}`} className={`plan-edge${edge.done ? " is-done" : ""}`} d={edge.path} markerEnd={`url(#${arrow}-${edge.done ? "done" : "wait"})`} />)}
        </svg>
        <ol className="plan-flow-nodes" aria-label={label}>
          {layout.nodes.map(({ step, x, y }) => {
            const Icon = ICONS[step.status];
            // the curves are drawn, not read: what a step waits on is said in words
            const before = step.blocked_by.flatMap((id) => labelOf.get(id) ?? []);
            return (
              <li key={step.id} className={`plan-node is-${step.status}${isOpen(step) ? " is-chosen" : ""}`} style={{ left: x, top: y, width: FLOW.nodeWidth, height: FLOW.nodeHeight }}>
                <button type="button" className="plan-node-open" aria-expanded={isOpen(step)} aria-controls={isOpen(step) ? detailId : undefined} title={step.active && step.status === "in_progress" ? `${step.label}\n${step.active}` : step.label} onClick={(event) => onOpen(step.id, step.label, event.currentTarget)}>
                  <span className="plan-node-label"><Icon aria-hidden="true" />{step.label}</span>
                  <span className="plan-node-meta">{meta(step)}</span>
                  {before.length > 0 && <span className="sr-only">{after(before)}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/**
 * What was done while one step ran (or while none did): its calls by tool, the last few, the
 * subagents and background commands it started. A subagent's state is the pane's subagent list's,
 * asked again while the detail is open.
 */
function StepDetail({ boxRef, id, paneId, label, status, meta, active, activity, now, onClose }: {
  boxRef: RefObject<HTMLElement>; id: string; paneId: string; label: string; status: PlanStep["status"] | null; meta: string | null;
  active: string | null; activity: PlanActivity | null; now: number; onClose: () => void;
}) {
  const t = useT();
  const { fetchPaneOmoActivity } = useMachineApi();
  const [agents, setAgents] = useState<Map<string, OmoTask>>(() => new Map());
  const asks = activity?.agents.some((agent) => agent.id !== null) ?? false;

  useEffect(() => {
    if (!asks) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (alive) setAgents(new Map(next.tasks.map((task) => [task.id, task])));
      } catch { /* the list is extra: its absence leaves the agents as started */ }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [asks, paneId, fetchPaneOmoActivity]);

  /** how long ago `at` was, as elapsed time; null when not told */
  const since = (at: string | null): string | null => {
    const then = at === null ? NaN : Date.parse(at);
    return Number.isFinite(then) ? formatElapsed(Math.max(0, now - then)) : null;
  };
  const ago = (at: string | null): string | null => { const time = since(at); return time === null ? null : t("{time} ago", { time }); };
  const agentWords: Record<OmoTask["status"], string> = { running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost") };
  const commandWords: Record<PlanActivity["background"][number]["status"], string> = { running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled") };
  const Icon = status === null ? null : ICONS[status];
  const total = activity?.tools.reduce((sum, tool) => sum + tool.count, 0) ?? 0;

  return (
    <section ref={boxRef} id={id} className="plan-detail" aria-label={t("Step details")}>
      <header className="plan-detail-head">
        <h3 className="plan-detail-title">{Icon && <Icon aria-hidden="true" />}{label}</h3>
        <button type="button" className="icon-button" aria-label={t("Close step")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {meta && <p className="plan-detail-meta">{meta}</p>}
      {active && <p className="plan-detail-active">{active}</p>}
      {activity === null ? (
        <p className="plan-note">{status === "pending" ? t("Not started yet.") : t("Nothing was done in this step yet.")}</p>
      ) : (
        <>
          <p className="plan-detail-tools">
            {[t(total === 1 ? "{n} tool call" : "{n} tool calls", { n: total }), since(activity.last_at) === null ? null : t("last action {time} ago", { time: since(activity.last_at)! })].filter((part) => part !== null).join(" · ")}
            <span className="plan-detail-tally">{activity.tools.map((tool) => `${tool.name} ${tool.count}`).join(" · ")}</span>
          </p>
          {activity.recent.length > 0 && (
            <>
              <h4 className="plan-detail-heading">{t("Recent actions")}</h4>
              <ol className="plan-detail-list">
                {[...activity.recent].reverse().map((call, index) => (
                  <li key={`${call.at ?? ""}-${index}`}>
                    <span className="plan-detail-tool">{call.tool}</span>
                    {call.detail && <span className="plan-detail-what">{call.detail}</span>}
                    {ago(call.at) && <span className="plan-detail-when">{ago(call.at)}</span>}
                  </li>
                ))}
              </ol>
            </>
          )}
          {activity.agents.length > 0 && (
            <>
              <h4 className="plan-detail-heading">{t("Subagents")}</h4>
              <ul className="plan-detail-list">
                {activity.agents.map((agent, index) => {
                  const task = agent.id === null ? undefined : agents.get(agent.id);
                  const facts = [agent.type, task ? agentWords[task.status] : null, task?.tokens == null ? null : t("{n} tokens", { n: formatTokens(task.tokens) })].filter((fact) => fact !== null);
                  return (
                    <li key={`${index}-${agent.id ?? ""}`} className={task ? `is-${task.status}` : undefined}>
                      <span className="plan-detail-what">{agent.label}</span>
                      {facts.length > 0 && <span className="plan-detail-when">{facts.join(" · ")}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {activity.background.length > 0 && (
            <>
              <h4 className="plan-detail-heading">{t("Background commands")}</h4>
              <ul className="plan-detail-list">
                {activity.background.map((command, index) => (
                  <li key={`${index}-${command.id}`} className={`is-${command.status}`}>
                    <span className="plan-detail-what">{command.command}</span>
                    <span className="plan-detail-when">{commandWords[command.status]}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
