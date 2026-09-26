import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";

import { useT } from "../lib/i18n.ts";

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
    setSending(true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        setText((current) => (current === written ? "" : current.startsWith(written) ? current.slice(written.length) : current));
      } else setNote(result);
    }).finally(() => setSending(false));
  }, [connected, onEnter, onSend, sending, t, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME still composing keeps its Enter
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const rows = Math.min(MAX_ROWS, Math.max(1, text.split("\n").length));
  return (
    <div className="terminal-input">
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
    </div>
  );
}
