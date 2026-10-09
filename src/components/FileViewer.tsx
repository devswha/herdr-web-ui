import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, List, X } from "lucide-react";

import "./FileViewer.css";
import "./ChatView.css";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { Markdown } from "./Markdown.tsx";

import type { FileInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

/** Bigger images are offered as a download: a phone decodes an image whole. */
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
/** Text shows its first part: the rest is a download away. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

export interface FileViewerProps {
  /** absolute, `~/…`, or relative to the pane's folder */
  path: string;
  paneId: string | null;
  onClose: () => void;
  /** Settings can open above this preview without closing it on Escape. */
  keyboardActive?: boolean;
  /** a file chosen in a folder's listing: opened as the preview, so history and a reload keep it */
  onOpen?: (path: string) => void;
}

/**
 * A file an agent wrote, opened in the browser: images, video and audio (streamed, so they
 * play and seek at once), PDFs, and the start of a text file. Anything can be downloaded.
 */
export function FileViewer({ path: asked, paneId, onClose, onOpen, keyboardActive = true }: FileViewerProps) {
  const t = useT();
  const { fetchFileInfo, fileUrl, fetchDirectories } = useMachineApi();
  // a remote PC's bridge reads a relative folder from the pane's folder only from its next bundle
  // on; until then it would list the bridge's own folder, so only an absolute or ~/ one is listed there
  const remote = useMachineId() !== LOCAL_MACHINE;
  const [directory, setDirectory] = useState<string | null>(null);
  // the path as given, until a choice among files of that name replaces it
  const [path, setPath] = useState(asked);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [markdownView, setMarkdownView] = useState<"rendered" | "source">("rendered");
  const [outline, setOutline] = useState<{ id: string; title: string; level: number }[]>([]);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const outlineId = useId();
  const documentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tocListRef = useRef<HTMLOListElement>(null);
  const headingElements = useRef<HTMLElement[]>([]);
  const surface = useFocusTrap<HTMLElement>(true);

  useEffect(() => setPath(asked), [asked]);

  useEffect(() => {
    let cancelled = false;
    setInfo(null); setCandidates(null); setError(null); setText(null); setDirectory(null);
    setMarkdownView("rendered");
    fetchFileInfo(path, paneId).then(async (next) => {
      if (cancelled) return;
      if ("candidates" in next) { setCandidates(next.candidates); return; }
      setInfo(next);
      if (next.kind !== "text") return;
      // only the first part of a text file travels: a range, whatever the file's size
      const response = await fetch(fileUrl(next.path, paneId), { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } });
      const body = await response.text();
      if (!cancelled) setText(body);
    }).catch(async (reason: unknown) => {
      if (cancelled) return;
      // a folder is listed from the pane's folder, as a file is found from it
      if (reason instanceof ApiError && reason.status === 404 && (!remote || /^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(path))) {
        try {
          const listing = await fetchDirectories(path, false, true, paneId);
          if (!cancelled) setDirectory(listing.path);
          return;
        } catch { /* retain the file error when the target is not a readable directory */ }
      }
      if (cancelled) return;
      setError(reason instanceof ApiError && reason.status === 404 ? t("No readable file at this path.") : t("The file could not be opened."));
    });
    return () => { cancelled = true; };
  }, [path, paneId, fetchFileInfo, fileUrl, fetchDirectories, remote]);

  useEffect(() => {
    if (!keyboardActive) return;
    // the FilesDialog beneath listens on window too (and stands down while this is open); this
    // one is the topmost overlay, so it takes the key
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape" && !nativeModalOver(surface.current)) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, keyboardActive]);

  // the file found (a bare name may have been found deeper in the folder), else as asked
  const url = fileUrl(info?.path ?? path, paneId);
  const isMarkdown = info?.kind === "text" && (/\.(?:md|markdown)$/i.test(info.name) || info.mime.split(";")[0] === "text/markdown");
  const markdownDocument = useMemo(() => {
    if (!isMarkdown || text === null) return null;
    const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    // Keep a plain opening thematic break as prose. Properties remain literal, not executable YAML.
    if (!frontmatter?.[1] || !/^[^\s:#][^:\r\n]*:[ \t]*(?:.*)$/m.test(frontmatter[1])) return { body: text, properties: null };
    return { body: text.slice(frontmatter[0].length), properties: frontmatter[1] };
  }, [isMarkdown, text]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const document = documentRef.current;
    setTocOpen(false);
    if (!body || !document || markdownView !== "rendered") {
      setOutline([]); setActiveHeading(null); headingElements.current = [];
      return;
    }
    const headings = [...document.querySelectorAll<HTMLElement>(".markdown :is(h1,h2,h3,h4,h5,h6)")];
    headingElements.current = headings;
    setOutline(headings.map((heading, index) => {
      const id = `${outlineId}-heading-${index}`;
      heading.id = id;
      heading.tabIndex = -1;
      // The math renderer has a hidden MathML copy; it is not a second heading label.
      const label = heading.cloneNode(true) as HTMLElement;
      label.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
      return { id, title: label.textContent?.trim() ?? "", level: Number([...heading.classList].find((name) => /^markdown-h[1-6]$/.test(name))?.slice(-1) ?? heading.tagName.slice(1)) };
    }));
    let frame = 0;
    const update = () => {
      const top = body.getBoundingClientRect().top + 20;
      let current = headings[0]?.id ?? null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > top) break;
        current = heading.id;
      }
      // The final section may be shorter than the viewport and cannot reach its top edge.
      if (body.scrollTop > 0 && body.scrollHeight - body.clientHeight - body.scrollTop <= 1) current = headings.at(-1)?.id ?? current;
      setActiveHeading(current);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    body.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(document);
    return () => {
      body.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [markdownDocument, markdownView, info?.path, outlineId]);
  useLayoutEffect(() => {
    const list = tocListRef.current;
    if (!list) return;
    const revealCurrent = () => {
      const current = list.querySelector<HTMLElement>('[aria-current="location"]');
      if (!current || list.clientHeight === 0) return;
      const row = current.getBoundingClientRect();
      const viewport = list.getBoundingClientRect();
      // Move only the outline's scroll owner, never the document or the browser viewport.
      const centered = list.scrollTop + row.top + row.height / 2 - viewport.top - list.clientHeight / 2;
      list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, centered));
    };
    revealCurrent();
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeHeading, outline, tocOpen]);
  const goToHeading = (id: string) => {
    const body = bodyRef.current;
    const heading = headingElements.current.find((element) => element.id === id);
    if (!body || !heading) return;
    body.scrollTo({ top: body.scrollTop + heading.getBoundingClientRect().top - body.getBoundingClientRect().top - 16, behavior: "instant" });
    heading.focus({ preventScroll: true });
    setActiveHeading(id); setTocOpen(false);
  };
  const openLinkedFile = (reference: string) => {
    const absolute = /^(?:[/\\]|~[/\\]|[A-Za-z]:[/\\])/.test(reference);
    const base = (info?.path ?? path).replace(/[^/\\]*$/, "");
    (onOpen ?? setPath)(absolute ? reference : `${base}${reference}`);
  };
  const body = (() => {
    if (directory !== null) return <DirectoryBrowser key={directory} start={directory} onOpenFile={onOpen ?? setPath} />;
    if (error !== null) return <p className="file-viewer-note" role="alert">{error}</p>;
    if (candidates !== null) return <div className="file-viewer-choices">
      <p className="file-viewer-note">Several files are named {path.split("/").pop()}:</p>
      <ul>{candidates.map((candidate) => <li key={candidate}><button type="button" className="btn btn-ghost" onClick={() => setPath(candidate)}>{candidate}</button></li>)}</ul>
    </div>;
    if (info === null) return <p className="file-viewer-note">{t("Opening…")}</p>;
    switch (info.kind) {
      case "image":
        return info.size > MAX_INLINE_IMAGE_BYTES
          ? <p className="file-viewer-note">This image is {formatBytes(info.size)}; download it to view.</p>
          : <img className="file-viewer-media" src={url} alt={info.name} />;
      case "video":
        return <video className="file-viewer-media" src={url} controls playsInline preload="metadata" />;
      case "audio":
        return <audio className="file-viewer-audio" src={url} controls preload="metadata" />;
      case "pdf":
        return <iframe className="file-viewer-pdf" src={url} title={info.name} />;
      case "text":
        return text === null ? <p className="file-viewer-note">{t("Opening…")}</p> : <>
          {markdownDocument && markdownView === "rendered"
            ? <div className="file-viewer-markdown" ref={documentRef}>
                {markdownDocument.properties !== null && <details className="file-viewer-properties" key={info.path}>
                  <summary>{t("Document properties")}</summary><pre>{markdownDocument.properties}</pre>
                </details>}
                <OpenFileContext.Provider value={openLinkedFile}><Markdown>{markdownDocument.body}</Markdown></OpenFileContext.Provider>
              </div>
            : <pre className="file-viewer-text">{text}</pre>}
          {info.size > TEXT_PREVIEW_BYTES && <p className="file-viewer-note">{t("Showing the first {shown} of {total}.", { shown: formatBytes(TEXT_PREVIEW_BYTES), total: formatBytes(info.size) })}</p>}
        </>;
      default:
        return <p className="file-viewer-note">{info.mime}, {formatBytes(info.size)}. This file can't be shown here; download it instead.</p>;
    }
  })();

  return (
    <div className="modal-scrim file-viewer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={surface} className="modal file-viewer" role="dialog" aria-modal="true" aria-label={info?.name ?? path} tabIndex={-1}>
        <header className="modal-header file-viewer-header">
          <div className="file-viewer-title">
            <h2 className="modal-title">{info?.name ?? path.split("/").pop()}</h2>
            <p className="file-viewer-meta" title={info?.path ?? path}>
              {info && <span className="file-viewer-size">{formatBytes(info.size)}</span>}
              <span className="file-viewer-path"><span dir="ltr">{info?.path ?? path}</span></span>
            </p>
          </div>
          <a className="icon-button" href={url} target="_blank" rel="noopener" aria-label={t(isMarkdown ? "Open original in a new tab" : "Open in a new tab")} title={t(isMarkdown ? "Open original in a new tab" : "Open in a new tab")}><ExternalLink aria-hidden="true" /></a>
          <a className="icon-button" href={fileUrl(info?.path ?? path, paneId, true)} download={info?.name ?? true} aria-label={t("Download")} title={t("Download")}><Download aria-hidden="true" /></a>
          <button type="button" className="icon-button" aria-label={t("Close file")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {isMarkdown && <div className="file-viewer-controls">
          <div className="segmented" role="group" aria-label={t("Markdown view")}>
            <button type="button" aria-pressed={markdownView === "rendered"} onClick={() => setMarkdownView("rendered")}>{t("Rendered")}</button>
            <button type="button" aria-pressed={markdownView === "source"} onClick={() => setMarkdownView("source")}>{t("Source")}</button>
          </div>
          {markdownView === "rendered" && outline.length > 0 && <button type="button" className="btn btn-ghost file-viewer-toc-toggle"
            aria-label={t("Table of contents")} aria-expanded={tocOpen} aria-controls={`${outlineId}-toc`}
            onClick={() => setTocOpen((open) => !open)}><List aria-hidden="true" />{t("Table of contents")}</button>}
        </div>}
        <div className="file-viewer-content">
          {markdownView === "rendered" && outline.length > 0 && <nav className="file-viewer-toc" id={`${outlineId}-toc`} aria-label={t("Table of contents")} data-open={tocOpen}>
            <div className="file-viewer-toc-title">{t("Table of contents")}</div>
            <ol ref={tocListRef}>{outline.map((heading) => <li key={heading.id}>
              <button type="button" data-level={heading.level} aria-current={activeHeading === heading.id ? "location" : undefined}
                onClick={() => goToHeading(heading.id)}>{heading.title}</button>
            </li>)}</ol>
          </nav>}
          <div ref={bodyRef} className={`file-viewer-body${isMarkdown && markdownView === "rendered" ? " is-markdown" : ""}`}>{body}</div>
        </div>
      </section>
    </div>
  );
}
