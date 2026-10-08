import { useEffect, useId, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import type { Machine, SetupJob } from "../../shared/machines.ts";
import { ApiError, fetchMachineSetup } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { BridgeUpdateProgress } from "./MachineSidebar.tsx";
import "./MachineSetupStatus.css";

export interface BackgroundSetup { job: SetupJob; name: string; machine?: Machine; updateRemote: boolean }

/**
 * Keeps installs put in the background visible when no PC row shows them: a new PC before it
 * joins the saved roster, or a PC whose bridge has to be installed again. A bridge update of a
 * PC in the sidebar shows on that PC's row instead (App leaves it out of `entries`).
 * The list stays mounted while closed, so each entry keeps polling its job.
 */
export function MachineSetupStatus({ entries, onOpen, onDismiss }: { entries: BackgroundSetup[]; onOpen(entry: BackgroundSetup): void; onDismiss(id: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  // closes as the plan meters' and the background tasks' popovers do: a press outside, or Escape
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);
  if (!entries.length) return null;
  return <div className="machine-setup-status" ref={root}>
    <button ref={toggle} className="icon-button" aria-label={t("PC installations")} title={t("PC installations")} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Download /><span className="machine-setup-count" aria-hidden="true">{entries.length}</span></button>
    <div id={id} className="machine-setup-list" role="dialog" hidden={!open} aria-label={t("PC installations")}>
      {entries.map((entry) => <SetupStatus key={entry.job.id} entry={entry} onOpen={onOpen} onDismiss={onDismiss} />)}
    </div>
  </div>;
}

function SetupStatus({ entry, onOpen, onDismiss }: { entry: BackgroundSetup; onOpen(entry: BackgroundSetup): void; onDismiss(id: string): void }) {
  const t = useT();
  const [job, setJob] = useState(entry.job);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const finished = gone || ["connected", "failed", "cancelled"].includes(job.phase);
  useEffect(() => {
    if (finished) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try { const next = await fetchMachineSetup(entry.job.id); if (!disposed) { setJob(next); setError(null); } }
      catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        if (e instanceof ApiError && e.code === "job_not_found") { setGone(true); return; }
      }
      if (!disposed) timer = window.setTimeout(poll, 750);
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [entry.job.id, finished]);
  return <section className="machine-setup-item">
    <strong>{entry.name || entry.machine?.name || job.target.destination}</strong>
    <div role="status">{finished || !job.progress ? <p>{job.step}</p> : <BridgeUpdateProgress update={{ job_id: job.id, step: job.step, progress: job.progress }} />}{(job.error || error) && <p className="machine-error">{job.error || error}</p>}</div>
    <div className="machine-setup-actions"><button className="btn" onClick={() => onOpen({ ...entry, job })}>{t("Open PC setup")}</button>{(finished || error) && <button className="icon-button" aria-label={t("Dismiss")} onClick={() => onDismiss(job.id)}><X /></button>}</div>
  </section>;
}
