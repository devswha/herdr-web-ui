import { useEffect, useState, type MouseEvent } from "react";
import { FolderOpen, X } from "lucide-react";

import "./OmpHistoryDialog.css";

import type { OmpSessionList } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

/** The workspace whose folder's earlier Oh My Pi sessions are listed, and where a resumed one opens. */
export interface OmpHistoryTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string;
}

export interface OmpHistoryDialogProps {
  target: OmpHistoryTarget | null;
  onClose: () => void;
  /** the pane the resumed session runs in: a new tab's, or the one that already had it */
  onResumed: (paneId: string) => void;
}

/**
 * Lists the folder's earlier Oh My Pi sessions (GET /api/workspace/omp-sessions) with a Resume
 * button each. Only the local PC keeps its sessions where the server reads them: App opens this
 * for the local PC alone, so a remote PC's workspace never shows it.
 */
export function OmpHistoryDialog({ target, onClose, onResumed }: OmpHistoryDialogProps) {
  const t = useT();
  const locale = useLocale();
  const { fetchOmpSessions, resumeOmpSession } = useMachineApi();
  const [list, setList] = useState<OmpSessionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const open = target !== null;
  const surface = useFocusTrap<HTMLDivElement>(open);
  useSheetSwipe(surface, resuming === null ? onClose : null);

  useEffect(() => {
    if (target === null) return;
    let cancelled = false;
    setList(null);
    setLoadError(null);
    fetchOmpSessions(target.cwd).then(
      (next) => { if (!cancelled) setList(next); },
      (reason: unknown) => { if (!cancelled) setLoadError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { cancelled = true; };
  }, [target, reload]);

  // a dialog opened on another workspace starts clean
  useEffect(() => {
    setResumeError(null);
    setResuming(null);
  }, [target]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (resuming === null) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, resuming]);

  if (target === null) return null;

  const resume = async (path: string): Promise<void> => {
    if (resuming !== null) return;
    setResuming(path);
    setResumeError(null);
    try {
      const result = await resumeOmpSession({ workspace_id: target.workspaceId, cwd: target.cwd, path });
      setResuming(null);
      if (!result.agent_started) {
        // the tab is there without omp in it, as a new tab whose agent failed to start is
        setResumeError(result.error?.message ?? t("Could not start Oh My Pi."));
        return;
      }
      onResumed(result.pane_id);
    } catch (reason: unknown) {
      setResuming(null);
      if (reason instanceof ApiError && reason.code === "invalid_session") {
        setResumeError(t("This session is no longer available."));
        setReload((tick) => tick + 1);
      } else setResumeError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (resuming === null && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim omp-history-scrim" onMouseDown={closeFromScrim}>
      <div ref={surface} className="modal omp-history-modal" role="dialog" aria-modal="true" aria-labelledby="omp-history-title" tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id="omp-history-title">{t("Earlier Oh My Pi sessions · {workspace}", { workspace: target.workspaceLabel })}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={resuming !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="new-session-folder">
            <FolderOpen aria-hidden="true" />
            <span>{target.cwd}</span>
          </div>
          {list === null && loadError === null && <p className="omp-history-state" role="status">{t("Loading sessions…")}</p>}
          {loadError !== null && (
            <div className="omp-history-state" role="alert">
              <p>{loadError}</p>
              <button type="button" className="btn" onClick={() => setReload((tick) => tick + 1)}>{t("Retry")}</button>
            </div>
          )}
          {list !== null && list.sessions.length === 0 && <p className="omp-history-state" role="status">{t("No earlier Oh My Pi sessions in this folder.")}</p>}
          {list !== null && list.sessions.length > 0 && (
            <ul className="omp-history-list">
              {list.sessions.map((session) => (
                <li key={session.path} className="omp-history-row">
                  <div className="omp-history-text">
                    <span className="omp-history-title">{session.title ?? session.preview ?? t("Untitled session")}</span>
                    {session.title !== null && session.preview !== null && <span className="omp-history-preview">{session.preview}</span>}
                    <span className="omp-history-meta">{new Date(session.updated_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</span>
                  </div>
                  <button type="button" className="btn" disabled={resuming !== null} onClick={() => void resume(session.path)}>
                    {resuming === session.path ? t("Resuming… up to 60s") : t("Resume")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list !== null && list.has_more && <p className="field-hint">{t("Only the latest {n} sessions are shown.", { n: list.sessions.length })}</p>}
          {list !== null && <p className="field-hint">{t("A session that is open in a pane is not listed.")}</p>}
          {resumeError !== null && <p className="field-hint new-session-error" role="alert">{resumeError}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={resuming !== null} onClick={onClose}>{t("Close")}</button>
        </footer>
      </div>
    </div>
  );
}
