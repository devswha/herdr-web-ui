/**
 * A yes-or-no question before something that cannot be undone. Cancel takes the focus, so Enter
 * answers no; Escape and the scrim answer no as well. The action runs here, so its failure shows
 * in the dialog and not beside a row that may be gone.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./ConfirmDialog.css";

import { useT } from "../lib/i18n.ts";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  /** resolves once the deed is done; the owner then takes the dialog down */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose }: Props) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { window.requestAnimationFrame(() => cancel.current?.focus()); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || pending) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const confirm = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try { await onConfirm(); }
    catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-body">
        <header className="modal-header"><h2 className="modal-title" id="confirm-dialog-title">{title}</h2></header>
        <div className="modal-body">
          <p className="confirm-body" id="confirm-dialog-body">{body}</p>
          {error && <p className="confirm-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="btn btn-danger" disabled={pending} onClick={() => void confirm()}>{confirmLabel}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
