import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Columns2, Copy, FileText, FoldVertical, Rows3, TriangleAlert, X } from "lucide-react";

import "./RepoDiffViewer.css";
import { RenderBoundary } from "./RenderBoundary.tsx";

import type { RepoDiffFilePatch } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { pathParts } from "../lib/filePaths.ts";
import { canHighlight, languageForPath } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { comparisonWord, diffColorable, diffErrorMessage, diffStyleFor, repositoryFilePath, statusWord, unavailableMessage, type RepoDiffTarget } from "../lib/repoDiff.ts";
import { useSettings } from "../lib/settings.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

const RepoDiff = lazy(() => import("./RepoDiff.tsx"));

export interface RepoDiffViewerProps {
  target: RepoDiffTarget;
  onClose: () => void;
  /** opens the file itself (an absolute path on the PC that holds the repository) in the file viewer */
  onOpenFile: (path: string) => void;
  /** a file preview or Settings above it takes Escape */
  keyboardActive?: boolean;
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; answer: RepoDiffFilePatch };
const PENDING: Load = { status: "pending" };

/** Copies the patch as git printed it; without a clipboard, shows it as a selected text box instead. */
function CopyPatchButton({ text, onShowText }: { text: string; onShowText: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const label = copied ? t("Patch copied") : t("Copy patch");
  const copy = async (): Promise<void> => {
    if (await copyText(text)) setCopied(true);
    else onShowText();
  };
  return <button type="button" className="icon-button repo-diff-action" aria-label={label} title={label} onClick={() => void copy()}>
    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
  </button>;
}

/**
 * One changed file of a repository, compared as the Changes list was: its patch as a window of
 * rows, unified or side by side (Settings → File viewer, one column on a phone), with the context
 * around each change folded to a line or shown whole, the file's status and counts in the header,
 * the file itself a tap away in the file viewer, and the patch copied as git printed it.
 */
export function RepoDiffViewer({ target, onClose, onOpenFile, keyboardActive = true }: RepoDiffViewerProps) {
  const t = useT();
  const { settings, update, resolvedTheme } = useSettings();
  const { fetchRepoDiffFile } = useMachineApi();
  const surface = useFocusTrap<HTMLElement>(true);
  const narrow = useMediaQuery(SHEET_QUERY);
  const [load, setLoad] = useState<Load>(PENDING);
  const [folded, setFolded] = useState(false);
  // the patch as one text box, selected, for Copy when the clipboard is out of reach
  const [selectable, setSelectable] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useSheetSwipe(surface, onClose);

  const { paneId, directory, scope, base, head, path, oldPath } = target;
  useEffect(() => {
    let live = true;
    setLoad(PENDING);
    setSelectable(false);
    fetchRepoDiffFile({ paneId, directory, scope, base, head }, path, oldPath).then(
      (answer) => { if (live) setLoad({ status: "ready", answer }); },
      (error: unknown) => { if (live) setLoad({ status: "failed", error }); },
    );
    return () => { live = false; };
  }, [fetchRepoDiffFile, paneId, directory, scope, base, head, path, oldPath]);

  useEffect(() => {
    if (!keyboardActive) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive, surface]);

  useLayoutEffect(() => {
    if (!selectable) return;
    textRef.current?.focus();
    textRef.current?.select();
  }, [selectable]);

  const answer = load.status === "ready" ? load.answer : null;
  const file = answer?.file ?? null;
  const patch = answer?.patch ?? null;
  const style = diffStyleFor(settings.diffStyle, narrow);
  const wantsColor = settings.highlightCode && canHighlight(languageForPath(path));
  const colored = patch !== null && diffColorable(settings.highlightCode, path, patch);
  const notes = [
    wantsColor && patch !== null && !colored ? t("Too long to highlight") : null,
    narrow && settings.diffStyle === "split" ? t("Split view needs a wider screen; showing one column.") : null,
  ].filter((note): note is string => note !== null);
  const { stem, extension } = pathParts(path);
  const { folder } = pathParts(path);
  const openable = answer !== null && file !== null && file.status !== "deleted";

  const body = (() => {
    if (load.status === "pending") return <p className="repo-diff-note">{t("Opening…")}</p>;
    if (load.status === "failed") {
      const stale = load.error instanceof ApiError && load.error.status === 404 && load.error.code === "not_found";
      return <p className="repo-diff-note" role="alert">{stale ? t("This file has no changes here any more; the list is out of date.") : diffErrorMessage(t, load.error)}</p>;
    }
    const unavailable = unavailableMessage(t, load.answer);
    if (unavailable !== null || patch === null) return <p className="repo-diff-note">{unavailable ?? t("No lines changed.")}</p>;
    if (selectable) return <textarea ref={textRef} className="repo-diff-select-source" readOnly value={patch} aria-label={t("Patch")} spellCheck={false} />;
    return <RenderBoundary resetKey={patch} fallback={() => <p className="repo-diff-note" role="alert">{t("This change can't be shown.")}</p>}>
      <Suspense fallback={<p className="repo-diff-note">{t("Opening…")}</p>}>
        <RepoDiff patch={patch} style={style} folded={folded} wrap={settings.wrapCode} theme={resolvedTheme} colored={colored} />
      </Suspense>
    </RenderBoundary>;
  })();

  return (
    <div className="modal-scrim repo-diff-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal repo-diff-viewer" role="dialog" aria-modal="true" aria-label={t("Changes to {name}", { name: `${stem}${extension}` })} ref={surface} tabIndex={-1}>
        <header className="modal-header repo-diff-header">
          <div className="repo-diff-title">
            <h2 className="modal-title"><span className="repo-diff-stem">{stem}</span>{extension}</h2>
            <p className="repo-diff-meta" title={oldPath === null ? path : t("Renamed from {path}", { path: oldPath })}>
              {file !== null && <span className="repo-diff-status" data-status={file.status}>{statusWord(t, file.status)}</span>}
              {file !== null && file.additions !== null && file.deletions !== null && <span className="repo-diff-counts">
                <span className="repo-diff-added">+{file.additions.toLocaleString()}</span>
                <span className="repo-diff-deleted">−{file.deletions.toLocaleString()}</span>
              </span>}
              {file?.binary === true && <span className="repo-diff-binary">{t("Binary")}</span>}
              {notes.length > 0 && <span className="repo-diff-notice" title={notes.join("\n")}>
                <TriangleAlert aria-hidden="true" />
                <span>{notes[0]}</span>
                <span className="visually-hidden">{notes.join(". ")}</span>
              </span>}
              <span className="repo-diff-compare">{comparisonWord(t, target)}</span>
              {folder !== "" && <span className="repo-diff-path"><span dir="ltr">{folder}</span></span>}
            </p>
          </div>
          <div className="repo-diff-actions">
            <div className="segmented repo-diff-styles" role="group" aria-label={t("Diff layout")}>
              <button type="button" aria-pressed={style === "unified"} onClick={() => update({ diffStyle: "unified" })}><Rows3 aria-hidden="true" />{t("Unified")}</button>
              <button type="button" aria-pressed={style === "split"} disabled={narrow} title={narrow ? t("Split view needs a wider screen") : undefined} onClick={() => update({ diffStyle: "split" })}><Columns2 aria-hidden="true" />{t("Split")}</button>
            </div>
            <div className="repo-diff-group">
              <button type="button" className="icon-button repo-diff-action" aria-pressed={folded} aria-label={t("Fold context")} title={folded ? t("Showing one line around each change") : t("Fold context")} disabled={patch === null} onClick={() => setFolded((value) => !value)}><FoldVertical aria-hidden="true" /></button>
              <button type="button" className="icon-button repo-diff-action" aria-label={t("Open file")} title={t("Open file")} disabled={!openable} onClick={() => answer !== null && onOpenFile(repositoryFilePath(answer.repository.root, path))}><FileText aria-hidden="true" /></button>
              {patch !== null && !selectable && <CopyPatchButton text={patch} onShowText={() => setSelectable(true)} />}
            </div>
          </div>
          <button type="button" className="icon-button repo-diff-action repo-diff-close" aria-label={t("Close diff")} title={t("Close diff")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="repo-diff-body">{body}</div>
      </section>
    </div>
  );
}
