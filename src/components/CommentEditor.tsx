/**
 * Writes, edits or deletes one block comment. The block shows on top, quoted, the comment below.
 * Saving a blank comment deletes it, so Delete is `onSave("")`; Save with the text unchanged only
 * closes, so a comment sent while its editor was open does not come back. Escape and the scrim
 * cancel; Tab stays inside; the focus goes back to what opened it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

import "./CommentEditor.css";

import { blockContent } from "../lib/blockComments.ts";
import { useT } from "../lib/i18n.ts";
import type { MarkdownBlock } from "../lib/markdown.ts";
import { MarkdownBlocks } from "./Markdown.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";

/** Longest comment, in UTF-16 units as `maxLength` counts. */
export const COMMENT_MAX_CHARS = 2000;

export interface CommentEditorProps {
  block: MarkdownBlock;
  /** "" when creating; otherwise the modal also offers Delete */
  initialComment: string;
  /** "" deletes */
  onSave: (comment: string) => void;
  onClose: () => void;
}

/** The modal editor for one block comment, portalled to `document.body` (see the file comment). */
export function CommentEditor({ block, initialComment, onSave, onClose }: CommentEditorProps) {
  const t = useT();
  const id = useId();
  const surface = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(initialComment);
  const save = (): void => { if (value.trim() === initialComment.trim()) onClose(); else onSave(value); };

  // one line to start, growing with the comment up to the cap in CSS, as the composer's box does
  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
  }, [value]);

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    window.requestAnimationFrame(() => {
      const node = field.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(node.value.length, node.value.length);
    });
  }, []);
  // Escape is this dialog's while it is up, not the composer's or the chat's underneath
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.target === field.current) {
      event.preventDefault();
      save();
      return;
    }
    if (event.key !== "Tab" || !surface.current) return;
    const stops = [...surface.current.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, a[href]")];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal comment-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Comment")}</h2></header>
        <div className="modal-body">
          {/* a stored block comes from localStorage, maybe from another version: one it cannot draw
              shows as text, and the comment stays editable (the pill's editor has no boundary above it) */}
          <div className="comment-editor-block">
            <RenderBoundary resetKey={block} fallback={() => <p className="comment-editor-plain">{blockContent(block)}</p>}>
              <MarkdownBlocks blocks={[block]} />
            </RenderBoundary>
          </div>
          <textarea
            ref={field}
            className="comment-editor-field"
            value={value}
            maxLength={COMMENT_MAX_CHARS}
            rows={1}
            aria-label={t("Comment")}
            placeholder={t("Write a comment…")}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <footer className="modal-footer">
          {initialComment !== "" && <button type="button" className="btn btn-danger comment-editor-delete" onClick={() => onSave("")}>{t("Delete")}</button>}
          <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={save}>{t("Save")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
