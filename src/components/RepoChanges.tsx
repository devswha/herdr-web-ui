import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { GitBranch, RefreshCw } from "lucide-react";

import "./RepoChanges.css";

import type { RepoDiffFile, RepoDiffFileList, RepoDiffScope } from "../../shared/protocol.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { diffErrorMessage, nothingChangedWord, STATUS_MARK, statusWord, type RepoComparison } from "../lib/repoDiff.ts";

export interface RepoChangesProps {
  paneId: string;
  /** the pane's folder, read when the pane is gone */
  directory: string;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
}

type Load = { status: "pending" } | { status: "failed"; error: unknown } | { status: "ready"; listing: RepoDiffFileList };
const PENDING: Load = { status: "pending" };

/**
 * What changed in the repository the pane sits in: the working tree, the index, or two commits,
 * one file per row with its status and counts, each opened as its diff. The list is read on each
 * choice and on Refresh, never polled.
 */
export function RepoChanges({ paneId, directory, onOpenDiff }: RepoChangesProps) {
  const t = useT();
  const locale = useLocale();
  const { fetchRepoDiffFiles } = useMachineApi();
  const [scope, setScope] = useState<RepoDiffScope>("workspace");
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  // the comparison read last: a commit comparison waits for Compare, the others read on choice
  const [asked, setAsked] = useState<RepoComparison | null>({ scope: "workspace", base: null, head: null });
  const [load, setLoad] = useState<Load>(PENDING);
  const request = useRef(0);

  const read = useCallback((comparison: RepoComparison) => {
    const id = ++request.current;
    setLoad(PENDING);
    fetchRepoDiffFiles({ paneId, directory, ...comparison }).then(
      (listing) => { if (id === request.current) setLoad({ status: "ready", listing }); },
      (error: unknown) => { if (id === request.current) setLoad({ status: "failed", error }); },
    );
  }, [fetchRepoDiffFiles, paneId, directory]);

  useEffect(() => { if (asked !== null) read(asked); }, [asked, read]);

  const choose = (next: RepoDiffScope): void => {
    setScope(next);
    if (next === "commit") { setAsked(null); setLoad(PENDING); return; }
    setAsked({ scope: next, base: null, head: null });
  };
  const compare = (event: FormEvent): void => {
    event.preventDefault();
    const from = base.trim();
    if (from === "") return;
    setAsked({ scope: "commit", base: from, head: head.trim() || null });
  };

  const listing = load.status === "ready" ? load.listing : null;
  // a file is read from the comparison the list answered for: a commit comparison's hashes
  const answered: RepoComparison | null = listing !== null ? { scope: listing.scope, base: listing.base, head: listing.head } : null;
  const repository = listing?.repository ?? null;
  const branch = repository === null ? null : repository.branch ?? (repository.unborn ? t("No commits yet") : t("Detached HEAD"));

  return (
    <div className="repo-changes" role="group" aria-label={t("Changes")} aria-busy={load.status === "pending"}>
      <div className="repo-changes-bar">
        <div className="segmented repo-changes-scopes" role="group" aria-label={t("Compare")}>
          <button type="button" aria-pressed={scope === "workspace"} onClick={() => choose("workspace")}>{t("Working tree")}</button>
          <button type="button" aria-pressed={scope === "staged"} onClick={() => choose("staged")}>{t("Staged")}</button>
          <button type="button" aria-pressed={scope === "commit"} onClick={() => choose("commit")}>{t("Commits")}</button>
        </div>
        <button type="button" className="icon-button" aria-label={t("Refresh changes")} title={t("Refresh changes")} disabled={asked === null || load.status === "pending"} onClick={() => asked !== null && read(asked)}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      {scope === "commit" && (
        <form className="repo-changes-commits" onSubmit={compare}>
          <label className="field">
            <span className="field-label">{t("From commit")}</span>
            <input className="input" value={base} onChange={(event) => setBase(event.target.value)} placeholder="HEAD~1" autoComplete="off" spellCheck={false} required />
          </label>
          <label className="field">
            <span className="field-label">{t("To commit")}</span>
            <input className="input" value={head} onChange={(event) => setHead(event.target.value)} placeholder="HEAD" autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={base.trim() === ""}>{t("Compare")}</button>
        </form>
      )}
      {repository !== null && (
        <p className="repo-changes-repo" title={repository.root}>
          <span className="repo-changes-branch"><GitBranch aria-hidden="true" />{branch}</span>
          <span className="repo-changes-root"><span dir="ltr">{repository.root}</span></span>
        </p>
      )}
      {load.status === "failed"
        ? <p className="repo-changes-note repo-changes-error" role="alert">{diffErrorMessage(t, load.error)}</p>
        : <ul className="repo-changes-list" aria-label={t("Changed files")} data-scope={listing?.scope}>
          {load.status === "pending" && <li className="repo-changes-note" role="status">{t("Loading…")}</li>}
          {listing !== null && answered !== null && listing.files.map((file) => {
            const word = statusWord(t, file.status);
            return <li key={file.path}>
              <button type="button" className="repo-change" onClick={() => onOpenDiff(answered, file)}>
                <span className="repo-change-mark" data-status={file.status} aria-hidden="true">{STATUS_MARK[file.status]}</span>
                <span className="visually-hidden">{word}</span>
                <span className="repo-change-path" title={file.old_path === null ? file.path : t("Renamed from {path}", { path: file.old_path })}>
                  {file.old_path !== null && <span className="repo-change-old">{file.old_path} → </span>}{file.path}
                </span>
                {file.binary === true
                  ? <span className="repo-change-counts">{t("Binary")}</span>
                  : file.additions !== null && file.deletions !== null && <span className="repo-change-counts">
                    <span className="repo-change-added">+{file.additions.toLocaleString(locale)}</span>
                    <span className="repo-change-deleted">−{file.deletions.toLocaleString(locale)}</span>
                  </span>}
              </button>
            </li>;
          })}
          {listing !== null && listing.files.length === 0 && <li className="repo-changes-note">{nothingChangedWord(t, listing.scope)}</li>}
          {listing?.truncated && <li className="repo-changes-note" role="status">
            {listing.total === null
              ? t("The list was cut short; only the first {count} files are shown.", { count: listing.files.length.toLocaleString(locale) })
              : t("Showing the first {count} of {total} changed files.", { count: listing.files.length.toLocaleString(locale), total: listing.total.toLocaleString(locale) })}
          </li>}
        </ul>}
    </div>
  );
}
