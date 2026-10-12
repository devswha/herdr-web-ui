import { useEffect, useState } from "react";
import { X } from "lucide-react";

import "./FilesDialog.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { RepoChanges } from "./RepoChanges.tsx";
import type { RepoDiffFile } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import type { RepoComparison } from "../lib/repoDiff.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";

export interface FilesDialogProps {
  /** the folder to open at: the pane's own */
  start: string;
  /** the pane whose repository's changes are listed */
  paneId: string;
  /** a file or a diff is open above this dialog: Escape belongs to it, which closes first */
  viewing: boolean;
  onOpenFile: (path: string) => void;
  onOpenDiff: (comparison: RepoComparison, file: RepoDiffFile) => void;
  onClose: () => void;
}

type Tab = "browse" | "changes";

/** The files of the pane's folder (and any other), each opened in the file viewer, and the changes of its repository, each opened as a diff. */
export function FilesDialog({ start, paneId, viewing, onOpenFile, onOpenDiff, onClose }: FilesDialogProps) {
  const t = useT();
  const surface = useFocusTrap<HTMLElement>(true);
  const [tab, setTab] = useState<Tab>("browse");
  // the changes are read with the first visit and kept, as the browser keeps its folder
  const [changesVisited, setChangesVisited] = useState(false);
  useSheetSwipe(surface, onClose);
  // a file opened from the list is drawn over it with an entry of its own: Back closes the file first
  usePhoneSheetBack(onClose, !viewing);
  useEffect(() => {
    if (viewing) return;
    // a native modal over it (Add PC, from the palette) takes its own Escape
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, viewing]);
  const show = (next: Tab): void => {
    setTab(next);
    if (next === "changes") setChangesVisited(true);
  };
  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="modal files-dialog" role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id="files-dialog-title">{t("Files")}</h2>
          <div className="segmented files-dialog-tabs" role="group" aria-label={t("Show")}>
            <button type="button" aria-pressed={tab === "browse"} onClick={() => show("browse")}>{t("Browse")}</button>
            <button type="button" aria-pressed={tab === "changes"} onClick={() => show("changes")}>{t("Changes")}</button>
          </div>
          <button type="button" className="icon-button" aria-label={t("Close files")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <div hidden={tab !== "browse"}><DirectoryBrowser start={start} onOpenFile={onOpenFile} /></div>
          {changesVisited && <div hidden={tab !== "changes"}><RepoChanges paneId={paneId} directory={start} onOpenDiff={onOpenDiff} /></div>}
        </div>
      </section>
    </div>
  );
}
