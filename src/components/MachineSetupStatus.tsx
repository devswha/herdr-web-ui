import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import type { Machine, SetupJob } from "../../shared/machines.ts";
import { fetchMachineSetup } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { BridgeUpdateProgress } from "./MachineSidebar.tsx";
import "./MachineSetupStatus.css";

export interface BackgroundSetup { job: SetupJob; name: string; machine?: Machine; updateRemote: boolean }

/** Keeps first-time installs visible before the PC joins the saved roster. */
export function MachineSetupStatus({ entries, onOpen, onDismiss }: { entries: BackgroundSetup[]; onOpen(entry: BackgroundSetup): void; onDismiss(id: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  return <div className="machine-setup-status">
    <button className="icon-button" aria-label={t("PC installations")} title={t("PC installations")} aria-expanded={open} onClick={() => setOpen(!open)}><Download /><span className="machine-setup-count">{entries.length}</span></button>
    <div className="machine-setup-list" hidden={!open} aria-label={t("PC installations")}>
      {entries.map((entry) => <SetupStatus key={entry.job.id} entry={entry} onOpen={onOpen} onDismiss={onDismiss} />)}
    </div>
  </div>;
}

function SetupStatus({ entry, onOpen, onDismiss }: { entry: BackgroundSetup; onOpen(entry: BackgroundSetup): void; onDismiss(id: string): void }) {
  const t = useT();
  const [job, setJob] = useState(entry.job);
  const [error, setError] = useState<string | null>(null);
  const finished = ["connected", "failed", "cancelled"].includes(job.phase);
  useEffect(() => {
    if (finished) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try { const next = await fetchMachineSetup(entry.job.id); if (!disposed) { setJob(next); setError(null); } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
      if (!disposed) timer = window.setTimeout(poll, 750);
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [entry.job.id, finished]);
  return <section className="machine-setup-item">
    <strong>{entry.name || entry.machine?.name || job.target.destination}</strong>
    <div role="status">{finished || !job.progress ? <p>{job.step}</p> : <BridgeUpdateProgress update={{ job_id: job.id, step: job.step, progress: job.progress }} />}{(job.error || error) && <p className="machine-error">{job.error || error}</p>}</div>
    <div className="machine-setup-actions"><button className="btn" onClick={() => onOpen({ ...entry, job })}>{t("Open PC setup")}</button>{finished && <button className="icon-button" aria-label={t("Dismiss")} onClick={() => onDismiss(job.id)}><X /></button>}</div>
  </section>;
}
