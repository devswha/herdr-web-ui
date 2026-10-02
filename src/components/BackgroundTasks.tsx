import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import { Circle, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleX, Layers, Workflow, type LucideProps } from "lucide-react";

import "./BackgroundTasks.css";

import { useMachineApi } from "../lib/machineContext.tsx";
import { clockOffsetMs, formatElapsed, spanMs, taskElapsedMs } from "../lib/omoTasks.ts";
import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import type { OmoRun, OmoRunNode, OmoTask } from "../../shared/protocol.ts";

const POLL_MS = 3000;

const ICONS: Record<OmoTask["status"], ComponentType<LucideProps>> = {
  running: CircleDot, completed: CircleCheck, failed: CircleX, cancelled: CircleSlash, lost: CircleAlert,
};
const NODE_ICONS: Record<OmoRunNode["state"], ComponentType<LucideProps>> = {
  pending: Circle, scheduled: Circle, running: CircleDot, blocked: CircleAlert, completed: CircleCheck, failed: CircleX, skipped: CircleSlash, cancelled: CircleSlash,
};

/**
 * The status line's "N background tasks": opens what OmO's background tasks are and how far they got.
 * Shown on every OmO pane (quiet while nothing runs: what ended in the last day can still be read,
 * after a reload too), and on any pane while a task runs.
 */
export function BackgroundTasks({ paneId, count, omo }: { paneId: string; count: number; omo: boolean }) {
  const t = useT();
  const { fetchPaneOmoActivity } = useMachineApi();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(count > 0);
  useEffect(() => { if (count > 0) setSeen(true); }, [count]);
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [runs, setRuns] = useState<OmoRun[]>([]);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** the PC's clock minus this browser's: task times are on the PC's */
  const [offset, setOffset] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (!alive) return;
        const received = Date.now();
        setTasks(next.tasks); setRuns(next.runs); setFailed(false); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch {
        // the clock stops with the list: a running task's time is no longer known to run on
        if (alive) setFailed(true);
      }
      if (!alive) return;
      timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [open, paneId, fetchPaneOmoActivity]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  const running = tasks?.filter((task) => task.status === "running") ?? [];
  const ended = tasks?.filter((task) => task.status !== "running") ?? [];
  const words: Record<OmoTask["status"], string> = {
    running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
  };

  const row = (task: OmoTask) => {
    const Icon = ICONS[task.status];
    const elapsed = taskElapsedMs(task, now + offset);
    const meta = [
      task.category, task.model, elapsed === null ? null : formatElapsed(elapsed),
      task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
      task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
      task.tokens === null ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
    ].filter((item) => item !== null).join(" · ");
    return <li key={task.id} className={`bg-task is-${task.status}`}>
      <Icon className="bg-task-icon" aria-hidden="true" />
      <span className="bg-task-main">
        <span className="bg-task-title">{task.title}<span className="sr-only"> ({words[task.status]})</span></span>
        {(meta.length > 0 || (task.status !== "running" && task.status !== "completed")) && <span className="bg-task-meta">{[task.status !== "running" && task.status !== "completed" ? words[task.status] : null, meta || null].filter((item) => item !== null).join(" · ")}</span>}
      </span>
    </li>;
  };

  const nodeWords: Record<OmoRunNode["state"], string> = {
    pending: t("waiting"), scheduled: t("waiting"), running: t("running"), blocked: t("blocked"), completed: t("done"), failed: t("failed"), skipped: t("skipped"), cancelled: t("cancelled"),
  };

  const runView = (run: OmoRun) => {
    const nodes = run.waves.flat();
    const done = nodes.filter((node) => node.state === "completed").length;
    const runningNow = nodes.filter((node) => node.state === "running").length;
    const failedNodes = nodes.filter((node) => node.state === "failed");
    const going = run.status === "running" || run.status === "pending" || run.status === "paused";
    const elapsed = spanMs(run.started_at, run.ended_at, going, now + offset);
    const meta = [
      t("{done} of {total} done", { done, total: nodes.length }),
      runningNow > 0 ? t("{n} running", { n: runningNow }) : null,
      failedNodes.length > 0 ? t("{n} failed", { n: failedNodes.length }) : null,
      run.status === "cancelled" ? t("cancelled") : run.status === "paused" ? t("paused") : run.status === "pending" ? t("waiting") : null,
      elapsed === null ? null : formatElapsed(elapsed),
    ].filter((item) => item !== null).join(" · ");
    return <li key={run.id} className={`bg-run is-${run.status}`}>
      <div className="bg-run-head"><Workflow className="bg-task-icon" aria-hidden="true" /><span className="bg-task-main"><span className="bg-task-title">{run.name}</span><span className="bg-task-meta">{meta}</span></span></div>
      <ol className="bg-run-waves">{run.waves.map((wave, index) => <li key={index} className="bg-run-wave">
        {wave.map((node) => {
          const Icon = NODE_ICONS[node.state];
          return <span key={node.id} className={`bg-node is-${node.state}`} title={node.error ?? undefined}><Icon aria-hidden="true" />{node.label}<span className="sr-only"> ({nodeWords[node.state]})</span></span>;
        })}
      </li>)}</ol>
      {failedNodes.filter((node) => node.error !== null).map((node) => <p key={node.id} className="bg-run-error">{node.label}: {node.error}</p>)}
    </li>;
  };


  if (count === 0 && !open && !seen && !omo) return null;
  return <span className="bg-tasks" ref={root}>
    <button type="button" className={`bg-tasks-toggle${count === 0 ? " is-idle" : ""}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Layers aria-hidden="true" />{count === 0 ? t("Background tasks") : t(count === 1 ? "{n} background task" : "{n} background tasks", { n: count })}
    </button>
    {open && <div id={id} className="menu bg-tasks-menu" role="dialog" aria-live="off" aria-label={t("Background tasks")}>
      {tasks === null && !failed && <p className="bg-tasks-note">{t("Loading…")}</p>}
      {failed && tasks === null && <p className="bg-tasks-note">{t("Couldn't load the background tasks")}</p>}
      {failed && tasks !== null && <p className="bg-tasks-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
      {tasks !== null && tasks.length === 0 && runs.length === 0 && <p className="bg-tasks-note">{t("No background tasks to show yet")}</p>}
      {runs.length > 0 && <><div className="menu-heading">{t("Workflows")}</div><ul className="bg-task-list">{runs.map(runView)}</ul></>}
      {running.length > 0 && <><div className="menu-heading">{t("Running")}</div><ul className="bg-task-list">{running.map(row)}</ul></>}
      {ended.length > 0 && <><div className="menu-heading">{t("Ended in the last day")}</div><ul className="bg-task-list">{ended.map(row)}</ul></>}
    </div>}
  </span>;
}
