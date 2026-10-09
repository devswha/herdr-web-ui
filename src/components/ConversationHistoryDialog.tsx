import { useEffect, useRef, useState } from "react";
import { ArrowLeft, History, Play, RefreshCw, X } from "lucide-react";
import type { SavedConversation, ResumeConversationResponse } from "../../shared/conversation-history.ts";
import type { ConversationPart, ConversationResponse } from "../../shared/protocol.ts";
import { fetchConversationHistory, fetchSavedConversation, fetchSavedToolOutput, resumeConversation, savedConversationImageUrl } from "../lib/api.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { turnRevision } from "../lib/turnRevision.ts";
import { Markdown } from "./Markdown.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import "./ChatView.css";
import "./ConversationHistoryDialog.css";

interface Props {
  readonly machineId: string;
  readonly machineName: string;
  readonly onClose: () => void;
  readonly onResume: (result: ResumeConversationResponse) => void;
}

function SavedPart({ part, id, machineId }: { part: ConversationPart; id: string; machineId: string }) {
  const t = useT();
  const [whole, setWhole] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, [id, machineId, part]);
  switch (part.kind) {
    case "text": return <Markdown>{part.text}</Markdown>;
    case "thinking": return <details className="saved-work"><summary>{t("Saved reasoning")}</summary><Markdown>{part.text}</Markdown></details>;
    case "notice":
    case "compact": return <details className="saved-work"><summary>{t(part.kind === "compact" ? "Conversation compacted" : "Background result delivered")}</summary><Markdown>{part.text}</Markdown></details>;
    case "skill": return <p className="saved-skill">{part.skill.name}</p>;
    case "image": return <a href={savedConversationImageUrl(id, part.ref, machineId)} target="_blank" rel="noreferrer"><img className="saved-image" loading="lazy" src={savedConversationImageUrl(id, part.ref, machineId)} alt={t("Saved image")} /></a>;
    case "task_result": return <div>{part.tasks.map((task) => <details className="saved-work" key={task.id}><summary>{task.title}</summary><Markdown>{task.result}</Markdown>{task.result_cut && <p>{t("This is the first part of a longer result")}</p>}</details>)}</div>;
    case "tool": return <details className={`saved-work${part.error ? " is-error" : ""}`}>
      <summary>{part.name}{part.summary && ` · ${part.summary}`}</summary>
      {part.input && <pre>{part.input}</pre>}
      {(whole ?? part.output) && <pre>{whole ?? part.output}</pre>}
      {part.images?.map((image) => <img key={image.ref} className="saved-image" loading="lazy" src={savedConversationImageUrl(id, image.ref, machineId)} alt={t("Saved image")} />)}
      {part.output_ref && whole === null && <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => {
        if (!part.output_ref) return;
        const version = ++request.current;
        setLoading(true); setError(null);
        void fetchSavedToolOutput(id, part.output_ref, machineId)
          .then((result) => { if (request.current === version) setWhole(result.output); })
          .catch((reason: unknown) => { if (request.current === version) setError(reason instanceof Error ? reason.message : String(reason)); })
          .finally(() => { if (request.current === version) setLoading(false); });
      }}>{t(loading ? "Loading the whole output…" : "Load saved output")}</button>}
      {error && <p role="alert">{error}</p>}
    </details>;
    default: { const unreachable: never = part; return unreachable; }
  }
}

export function ConversationHistoryDialog({ machineId, machineName, onClose, onResume }: Props) {
  const t = useT();
  const phone = useMediaQuery("(max-width: 768px)");
  const [records, setRecords] = useState<readonly SavedConversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [older, setOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationResponse | null>(null);
  const selection = useRef(selected);
  selection.current = selected;
  const generation = useRef(0);
  const busy = useRef(resuming);
  busy.current = resuming;
  const search = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const entry = records.find((record) => record.id === selected);

  useEffect(() => {
    const previous = document.activeElement;
    search.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy.current) onClose(); }
      if (event.key !== "Tab") return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, a[href], summary') ?? [])].filter((element) => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose]);

  useEffect(() => {
    if (!phone) return;
    if (selected === null) search.current?.focus();
    else dialog.current?.querySelector<HTMLButtonElement>(".history-back")?.focus();
  }, [selected, phone]);

  useEffect(() => {
    let current = true;
    setLoading(true); setError(null);
    void fetchConversationHistory(machineId).then((result) => {
      if (current) setRecords(result.conversations);
    }).catch((reason: unknown) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [machineId, refresh]);

  useEffect(() => {
    let current = true;
    generation.current += 1;
    setConversation(null); setReadError(null); setOlder(false);
    if (selected === null) { setReading(false); return; }
    setReading(true);
    void fetchSavedConversation(selected, machineId).then((result) => {
      if (current) setConversation(result);
    }).catch((reason: unknown) => { if (current) setReadError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current) setReading(false); });
    return () => { current = false; generation.current += 1; };
  }, [selected, machineId, refresh]);

  const needle = query.trim().toLocaleLowerCase();
  const shown = records.filter((record) => `${record.title} ${record.cwd} ${record.agent} ${record.session_id ?? ""}`.toLocaleLowerCase().includes(needle));
  const resume = async () => {
    if (!selected || busy.current) return;
    const id = selected, requestGeneration = generation.current;
    busy.current = true;
    setResuming(true); setReadError(null);
    try {
      const result = await resumeConversation(id, machineId);
      if (selection.current === id && generation.current === requestGeneration) onResume(result);
    }
    catch (reason) { if (selection.current === id && generation.current === requestGeneration) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (selection.current === id && generation.current === requestGeneration) { busy.current = false; setResuming(false); } }
  };
  const loadOlder = async () => {
    if (!selected || !conversation?.cursor || older) return;
    const id = selected;
    const requestGeneration = generation.current;
    setOlder(true); setReadError(null);
    try {
      const page = await fetchSavedConversation(id, machineId, conversation.cursor);
      if (selection.current !== id || generation.current !== requestGeneration) return;
      setConversation((current) => current && current.history_id === page.history_id
        ? { ...current, turns: [...page.turns, ...current.turns], cursor: page.cursor } : page);
    } catch (reason) { if (selection.current === id && generation.current === requestGeneration) setReadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (selection.current === id && generation.current === requestGeneration) setOlder(false); }
  };

  return <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !resuming) onClose(); }}>
    <section ref={dialog} className="modal conversation-history-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-history-title" data-preview={selected !== null}>
      <header className="modal-header">
        <h2 id="conversation-history-title" className="modal-title"><History aria-hidden="true" />{t("Conversation history")}</h2>
        <span className="history-machine">{machineName}</span>
        <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} disabled={loading || resuming} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={t("Close conversation history")} title={t("Close conversation history")} disabled={resuming} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {error && <p className="history-error" role="alert">{error}</p>}
      <div className="history-layout">
        <div className="history-list-column">
          <label className="history-search"><span className="field-label">{t("Search conversations")}</span><input ref={search} className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <div className="history-list" aria-label={t("Saved conversations")}>
            {loading && <p className="history-empty" role="status">{t("Loading…")}</p>}
            {!loading && shown.length === 0 && <p className="history-empty" role="status">{t("No saved conversations")}</p>}
            {shown.map((record) => <button type="button" key={record.id} className={`history-entry${selected === record.id ? " is-selected" : ""}`} aria-current={selected === record.id ? "true" : undefined} disabled={resuming} onClick={() => setSelected(record.id)}>
              <span className="history-entry-title">{record.title}</span>
              <span className="history-entry-cwd" title={record.cwd}>{record.cwd}</span>
              <span className="history-entry-meta"><span>{record.agent}{record.session_id && ` · ${record.session_id.slice(0, 8)}`}</span><span>{t(record.state === "open" ? "Open conversation" : record.state === "closed" ? "Closed conversation" : "Conversation unavailable")}</span><time dateTime={new Date(record.updated_at).toISOString()}>{new Date(record.updated_at).toLocaleDateString(currentLocale())}</time></span>
            </button>)}
          </div>
        </div>
        <div className="history-preview">
          <div className="history-preview-header">
            <button type="button" className="btn btn-ghost history-back" disabled={resuming} onClick={() => setSelected(null)}><ArrowLeft aria-hidden="true" />{t("Back to conversations")}</button>
            <h3>{entry?.title ?? t("Select a saved conversation")}</h3>
            {entry && <button type="button" className="btn btn-primary" disabled={!entry.can_resume || resuming} onClick={() => void resume()}><Play aria-hidden="true" />{t(resuming ? "Opening…" : entry.pane_id ? "Open pane" : "Resume conversation")}</button>}
          </div>
          {entry?.error && <p className="history-error" role="status">{entry.error}</p>}
          {readError && <p className="history-error" role="alert">{readError}</p>}
          <div className="chat-view saved-conversation-view">
            {reading && <p role="status">{t("Loading conversation…")}</p>}
            {conversation && <OpenFileContext.Provider value={null}><div className="chat-transcript">
              {conversation.cursor && <button type="button" className="btn btn-ghost" disabled={older} onClick={() => void loadOlder()}>{t(older ? "Loading earlier messages…" : "Load earlier messages")}</button>}
              {conversation.turns.map((turn, index) => <RenderBoundary key={`${conversation.history_id}:${conversation.turns.length - index}`}
                resetKey={turnRevision(turn)} fallback={() => <p className="history-error" role="alert">{t("This saved message could not be displayed.")}</p>}>
                <article className={`chat-turn ${turn.role === "user" ? "chat-turn-user" : "chat-turn-agent"}`}>
                  <div className={turn.role === "user" ? "chat-bubble" : undefined}>{turn.parts.map((part, partIndex) => <SavedPart key={partIndex} part={part} id={selected ?? ""} machineId={machineId} />)}</div>
                </article>
              </RenderBoundary>)}
              {conversation.turns.length === 0 && <p className="history-empty">{t("This conversation has no messages yet")}</p>}
            </div></OpenFileContext.Provider>}
          </div>
        </div>
      </div>
    </section>
  </div>;
}
