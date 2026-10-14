import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CornerLeftUp } from "lucide-react";

import "./DirectoryField.css";
import { FileGlyph } from "./FileGlyph.tsx";

import type { DirectoryListing } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { browseEntries, folderQuery, folderQueryFor } from "../lib/paletteFolders.ts";

/** A folder the typed path names that is not there yet: `name` inside the existing folder `parent`. */
export interface MissingFolder {
  parent: string;
  name: string;
}

export interface DirectoryFieldProps {
  id: string;
  /** the path as typed: absolute, `~` or `~/…` */
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  /** told when the path's last part names a folder that does not exist, and null when it does */
  onMissing: (missing: MissingFolder | null) => void;
  /** the field's hint, kept in sight between the path and the list */
  children: ReactNode;
}

const UP = "..";

/**
 * The directory field of New workspace (after T3 Code's Add project): the path is also the search.
 * Its last part filters the folders of the folder before it, listed under the field while it has
 * focus; a folder picked from the list is written into the path and its own folders follow.
 */
export function DirectoryField({ id, value, disabled, onChange, onMissing, children }: DirectoryFieldProps) {
  const t = useT();
  const { fetchDirectories } = useMachineApi();
  const listId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  // the folder listed, under the request that asked for it: a slower answer for an earlier path is dropped
  const [listed, setListed] = useState<{ key: string; listing: DirectoryListing | null; error: string | null } | null>(null);
  const request = useRef(0);

  // a bare word is looked for in home, as the hint's `~/…` reads; a relative path names no folder
  const query = folderQuery(value) ?? (/[\\/]/u.test(value) ? null : { directory: "~", filter: value });
  const directory = query?.directory ?? null;
  const filter = query?.filter ?? "";
  const hidden = filter.startsWith(".");
  const key = directory === null ? null : `${directory}\n${hidden ? 1 : 0}`;

  useEffect(() => {
    if (key === null || directory === null) return;
    const mine = ++request.current;
    fetchDirectories(directory, hidden).then(
      (listing) => { if (mine === request.current) setListed({ key, listing, error: null }); },
      (reason: unknown) => {
        if (mine !== request.current) return;
        setListed({
          key, listing: null,
          error: reason instanceof ApiError && reason.status === 404 ? t("This PC's bridge cannot browse folders yet. Type the path instead.")
            : reason instanceof ApiError && reason.code === "invalid_cwd" ? t("This folder cannot be opened.") : t("Folders could not be loaded."),
        });
      },
    );
  }, [key, fetchDirectories, t]);

  const current = listed !== null && listed.key === key ? listed : null;
  const listing = current?.listing ?? null;
  const names = listing ? browseEntries(listing.directories, filter) : [];
  const rows = listing?.parent ? [UP, ...names] : names;
  const missingName = listing !== null && filter !== "" && filter !== "." && filter !== UP && !listing.directories.includes(filter) ? filter : null;
  const missingParent = missingName === null ? null : listing!.path;
  useEffect(() => {
    onMissing(missingName === null || missingParent === null ? null : { parent: missingParent, name: missingName });
  }, [missingName, missingParent]);

  useEffect(() => { setHighlight(-1); }, [value]);
  useEffect(() => {
    if (highlight >= 0) listRef.current?.children[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const pick = (row: string): void => {
    if (row === UP) {
      if (listing?.parent) onChange(folderQueryFor(listing.parent, listing.home));
      return;
    }
    const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
    onChange(`${cut < 0 ? "~/" : value.slice(0, cut + 1)}${row}/`);
  };

  const open = active && !disabled && key !== null;
  return (
    <div className="dir-field" ref={wrapper}
      onFocus={() => setActive(true)}
      onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget)) setActive(false); }}>
      <input id={id} className="input" value={value} disabled={disabled} autoComplete="off" spellCheck={false}
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter confirms an IME candidate; Escape dismisses it, not the dialog.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            event.stopPropagation();
            return;
          }
          if (!open || rows.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setHighlight((at) => at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length);
          } else if (event.key === "Enter" && highlight >= 0) {
            // Enter on a highlighted folder walks into it; with none highlighted it starts the workspace
            event.preventDefault();
            pick(rows[highlight]!);
          } else if (event.key === "Escape" && highlight >= 0) {
            event.preventDefault();
            event.stopPropagation();
            setHighlight(-1);
          }
        }} />
      {children}
      {open && (
        <ul id={listId} ref={listRef} className="dir-field-list" role="listbox" aria-label={t("Folders")} aria-busy={current === null}>
          {rows.map((row, index) => (
            // the press keeps the caret in the field, so the next letters go on filtering
            <li key={row} id={`${listId}-${index}`} className="dir-field-item" role="option" aria-selected={index === highlight}
              aria-label={row === UP ? t("Parent folder") : undefined}
              onMouseDown={(event) => event.preventDefault()} onClick={() => pick(row)}>
              {row === UP ? <CornerLeftUp aria-hidden="true" /> : <FileGlyph name={row} kind="directory" />}
              <span>{row}</span>
            </li>
          ))}
          {current === null && <li className="dir-field-note" role="status">{t("Loading…")}</li>}
          {current?.error && <li className="dir-field-note is-error" role="alert">{current.error}</li>}
          {listing !== null && names.length === 0 && missingName === null && <li className="dir-field-note">{t("No folders here")}</li>}
          {listing?.truncated && <li className="dir-field-note">{t("Showing the first {n} folders; type the rest of the path to go further.", { n: listing.directories.length })}</li>}
        </ul>
      )}
    </div>
  );
}
