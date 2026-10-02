import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  connected: boolean;
  /** true: sent, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onSend: (text: string) => false | Promise<true | string>;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue */
  onEnter: () => boolean;
}

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable, autocorrect), and a terminal
 * cannot take back keys it already sent: every revision arrived as more text. Here the line
 * is written with the keyboard's own editing and goes to the pane whole, then Enter.
 */
export function TerminalInput({ connected, onSend, onEnter }: TerminalInputProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  const send = useCallback(() => {
    if (!connected || sending) return;
    setNote(null);
    if (text.length === 0) {
      if (!onEnter()) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(text);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    const written = text;
    // a polish that lands before the acknowledgement would read as text typed meanwhile, and
    // leave the sent command in the line
    dictation.forget();
    setSending(true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        setText((current) => (current === written ? "" : current.startsWith(written) ? current.slice(written.length) : current));
      } else setNote(result);
    }).finally(() => setSending(false));
  }, [connected, dictation.forget, onEnter, onSend, sending, t, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}`}>
      <textarea
        ref={box}
        className="terminal-input-text"
        rows={rows}
        value={text}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        autoCapitalize="off"
        disabled={!connected}
        onChange={(event) => { setText(event.target.value); setNote(null); }}
        onKeyDown={onKeyDown}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <button
        type="button"
        className="terminal-input-send"
        aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        disabled={!connected || sending}
        // the soft keyboard stays up for the next line
        onPointerDown={(event) => event.preventDefault()}
        onClick={send}
      >
        {text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
      </button>
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
