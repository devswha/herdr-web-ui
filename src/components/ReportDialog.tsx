import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, ExternalLink, X } from "lucide-react";

import "./ReportDialog.css";

import { fetchHealth } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { buildReport, issueUrl, reportTitle } from "../lib/report.ts";
import type { AgentStatus, ConversationResponse, InteractivePrompt } from "../../shared/protocol.ts";

declare const __APP_VERSION__: string;

/** The newest turns a report carries: the one that looked wrong is almost always among them. */
const REPORT_TURNS = 3;
const SCREEN_LINES = 60;

export interface ReportDialogProps {
  paneId: string;
  agent: string | null;
  agentStatus?: AgentStatus;
  model: string | null;
  onClose: () => void;
}

interface Gathered {
  conversation: ConversationResponse | null;
  prompt: InteractivePrompt | null;
  screen: string | null;
  herdr: string | null;
}

/**
 * Report a problem with this pane's chat: what was seen, where, and the pieces it is built
 * from, gathered here and shown whole. Nothing leaves the page on its own: the text can be
 * edited, then copied, saved as a file, or opened as a prefilled GitHub issue.
 */
export function ReportDialog({ paneId, agent, agentStatus, model, onClose }: ReportDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchPaneConversation, fetchPanePrompt, fetchPaneTranscript } = useMachineApi();
  const [gathered, setGathered] = useState<Gathered | null>(null);
  const [description, setDescription] = useState("");
  const [include, setInclude] = useState({ turns: true, prompt: true, screen: false });
  const [editedReport, setEditedReport] = useState<string | null>(null);
  const [environment] = useState(() => ({
    app: __APP_VERSION__, machine: machineId, agent, status: agentStatus ?? null, model,
    browser: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}${window.matchMedia?.("(pointer: coarse)").matches ? " touch" : ""}`,
  }));
  const [note, setNote] = useState<string | null>(null);
  const preview = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    const quietly = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
    void Promise.all([
      quietly(fetchPaneConversation(paneId)),
      quietly(fetchPanePrompt(paneId)),
      quietly(fetchPaneTranscript(paneId, SCREEN_LINES)),
      quietly(fetchHealth()),
    ]).then(([conversation, prompt, screen, health]) => {
      if (!cancelled) setGathered({ conversation, prompt, screen: screen?.text ?? null, herdr: health?.herdr.version ?? null });
    });
    return () => { cancelled = true; };
  }, [fetchPaneConversation, fetchPanePrompt, fetchPaneTranscript, paneId]);

  // Keep manual edits (including redactions) intact as props or inclusion choices change.
  const generatedReport = useMemo(() => {
    if (gathered === null) return "";
    return buildReport({
      description,
      environment: { ...environment, herdr: gathered.herdr, source: gathered.conversation?.source ?? null },
      turns: include.turns ? (gathered.conversation?.turns ?? []).slice(-REPORT_TURNS) : null,
      prompt: include.prompt ? gathered.prompt : undefined,
      screen: include.screen ? gathered.screen ?? "" : null,
    });
  }, [description, gathered, include, environment]);
  const report = editedReport ?? generatedReport;
  const issue = issueUrl(reportTitle(description, environment.agent), report);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fileName = `herdr-report-${paneId.replace(/[^A-Za-z0-9_-]/g, "-")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`;
  const save = (): void => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([report], { type: "text/markdown" }));
    link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const copy = async (): Promise<void> => setNote(t(await copyText(report, preview.current) ? "Copied" : "Copy failed: select the text and copy it"));

  const choice = (key: keyof typeof include, label: string) => (
    <label className="report-choice">
      <input type="checkbox" checked={include[key]} onChange={(event) => setInclude((current) => ({ ...current, [key]: event.target.checked }))} />
      {label}
    </label>
  );

  return (
    <div className="modal-scrim report-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <header className="modal-header">
          <h2 className="modal-title" id="report-title">{t("Report a problem")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X /></button>
        </header>
        <div className="modal-body report-body">
          <label className="report-label" htmlFor="report-description">{t("What went wrong?")}</label>
          <textarea id="report-description" className="input report-description" rows={2} value={description}
            placeholder={t("e.g. the list numbers read 1. 1. 1.")} onChange={(event) => setDescription(event.target.value)} />
          <fieldset className="report-choices">
            <legend>{t("Include in report")}</legend>
            {choice("turns", t("Latest {n} turns, as parsed", { n: REPORT_TURNS }))}
            {choice("prompt", t("Prompt card, as parsed"))}
            {choice("screen", t("Terminal screen"))}
          </fieldset>
          <p className="settings-description">{t("Nothing is sent on its own. Read it first: a conversation can hold code or secrets. Edit anything out below.")}</p>
          <div className="report-preview-heading">
            <label className="report-label" htmlFor="report-preview">{t("Review and edit report")}</label>
            <span className="report-size">{t("{n} characters", { n: report.length })}</span>
          </div>
          {editedReport !== null && <div className="report-edit-note">
            <p>{t("Your edits are kept. Rebuilding applies the choices above and replaces your edits.")}</p>
            <button type="button" className="btn" onClick={() => setEditedReport(null)}>{t("Rebuild report")}</button>
          </div>}
          <textarea id="report-preview" ref={preview} className="input report-preview" aria-label={t("Report")} value={gathered === null ? t("Gathering…") : report}
            readOnly={gathered === null} spellCheck={false} onChange={(event) => setEditedReport(event.target.value)} />
          {note !== null && <p className="settings-hint" role="status">{note}</p>}
        </div>
        <footer className="modal-footer report-footer">
          {gathered !== null && issue.cut && <p className="report-handoff" role="status">{t("This report is too long to prefill. Copy or save it, then paste or attach it on GitHub.")}</p>}
          <div className="report-footer-actions">
          <button type="button" className="btn" disabled={gathered === null} onClick={() => void copy()}><Copy aria-hidden="true" size={16} />{t("Copy")}</button>
          <button type="button" className="btn" disabled={gathered === null} onClick={save}><Download aria-hidden="true" size={16} />{t("Save as file")}</button>
          {gathered === null
            ? <button type="button" className="btn btn-primary" disabled>{t("Open a GitHub issue")}</button>
            : <a className="btn btn-primary report-github" href={issue.url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" size={16} />{t("Open a GitHub issue")}</a>}
          </div>
        </footer>
      </section>
    </div>
  );
}
