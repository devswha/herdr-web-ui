import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Maximize2, Minus, Plus, Scan, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { nativeModalOver } from "../lib/useFocusTrap.ts";
import { mermaidInputAllowed, renderMermaid, type MermaidImage } from "../lib/mermaidRender.ts";
import "./MermaidBlock.css";

type ImageView = MermaidImage & { url: string };
const clampZoom = (zoom: number) => Math.min(8, Math.max(Number.EPSILON, zoom));

function ExpandedDiagram({ image, onClose }: { image: ImageView; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fit = () => {
    const node = stage.current;
    if (node) setZoom(Math.max(Number.EPSILON, Math.min(1, (node.clientWidth - 24) / image.width, (node.clientHeight - 24) / image.height)));
  };
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal(); fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage.current!);
    return () => {
      observer.disconnect(); node.close();
      if (opener.current?.isConnected && !nativeModalOver(node)) opener.current.focus({ preventScroll: true });
    };
  }, [image]);
  return createPortal(<dialog className="mermaid-dialog" ref={dialog} aria-label={t("Mermaid diagram")}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); event.stopPropagation(); setZoom((value) => clampZoom(value * 1.25)); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); event.stopPropagation(); setZoom((value) => clampZoom(value / 1.25)); }
      else if (event.key === "0") { event.preventDefault(); event.stopPropagation(); fit(); }
    }}>
    <header className="mermaid-toolbar"><span>{t("Mermaid diagram")}</span>
      <button className="icon-button" type="button" aria-label={t("Zoom out")} onClick={() => setZoom((value) => clampZoom(value / 1.25))}><Minus aria-hidden="true" /></button>
      <output aria-live="polite">{Math.round(zoom * 100)}%</output>
      <button className="icon-button" type="button" aria-label={t("Zoom in")} onClick={() => setZoom((value) => clampZoom(value * 1.25))}><Plus aria-hidden="true" /></button>
      <button className="icon-button" type="button" aria-label={t("Fit diagram")} onClick={fit}><Scan aria-hidden="true" /></button>
      <button className="icon-button" type="button" aria-label={t("Close diagram")} onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="mermaid-large-stage" ref={stage}><img className="mermaid-image" src={image.url} alt={t("Mermaid diagram")} style={{ width: image.width * zoom, height: image.height * zoom }} /></div>
  </dialog>, document.body);
}

/** Source stays available while streaming, during loading, and after every rejected render. */
export function MermaidBlock({ value, complete, children }: { value: string; complete: boolean; children: ReactNode }) {
  const t = useT();
  const { resolvedTheme } = useSettings();
  const key = `${resolvedTheme}\0${value}`;
  const generation = useMemo(() => ({}), [value, resolvedTheme, complete]);
  const [result, setResult] = useState<{ generation: object; image: ImageView | null } | null>(null);
  const [source, setSource] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const allowed = complete && mermaidInputAllowed(value);
  const image = allowed && result?.generation === generation ? result.image : null;
  useEffect(() => {
    setExpanded(null);
    if (!allowed) return;
    let live = true;
    let url: string | undefined;
    renderMermaid(value, resolvedTheme).then((rendered) => {
      if (!live) return;
      url = URL.createObjectURL(new Blob([rendered.svg], { type: "image/svg+xml" }));
      setResult({ generation, image: { ...rendered, url } });
    }, () => { if (live) setResult({ generation, image: null }); });
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [value, resolvedTheme, complete, allowed, generation]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); }
  };
  return <section className="mermaid-block">
    {image && <div className="mermaid-toolbar">
      <button type="button" className="btn btn-ghost" aria-pressed={!source} onClick={() => setSource(false)}>{t("Diagram")}</button>
      <button type="button" className="btn btn-ghost" aria-pressed={source} onClick={() => setSource(true)}>{t("Source")}</button>
      <button className="icon-button" type="button" aria-label={copied ? t("Code copied") : t("Copy code")} onClick={() => void copy()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>
      <button className="icon-button" type="button" aria-label={t("Expand diagram")} onClick={() => setExpanded(key)}><Maximize2 aria-hidden="true" /></button>
    </div>}
    {image && !source ? <div className="mermaid-preview"><img className="mermaid-image" src={image.url} alt={t("Mermaid diagram")} onError={() => setResult((current) => current?.generation === generation ? { generation, image: null } : current)} /></div> : children}
    {!image && <p className="mermaid-note" role="status">{allowed && result?.generation !== generation ? t("Rendering diagram…") : complete ? t("Diagram unavailable. Source is shown.") : t("The diagram will appear when this block is complete.")}</p>}
    {image && expanded === key && <ExpandedDiagram image={image} onClose={() => setExpanded(null)} />}
  </section>;
}
