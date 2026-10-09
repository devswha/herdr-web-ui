import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { AgentStatus } from "../../shared/protocol.ts";
import { lastPromptIndex, promptLine, promptOf, type SentPrompt } from "../lib/last-prompt.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { usePageVisible } from "../lib/visibility.ts";
import { useT } from "../lib/i18n.ts";
import "./LastPromptBar.css";

export function LastPromptBar({ prompt, onOpen, className }: { prompt: SentPrompt; onOpen: () => void; className: string }) {
  const t = useT();
  const line = promptLine(prompt, (n) => t(n === 1 ? "[{n} image]" : "[{n} images]", { n }));
  return <button type="button" className={`last-prompt ${className}`} title={t("Go to my last prompt")} aria-label={`${t("Go to my last prompt")}: ${line}`} onClick={onOpen}>
    <MessageSquare className="last-prompt-icon" aria-hidden="true" />
    <span className="last-prompt-text">{line}</span>
  </button>;
}

/** The terminal has no ChatView. Read its transcript on entry and status changes, not its draft. */
export function TerminalLastPromptBar({ paneId, agentStatus, onOpen }: { paneId: string; agentStatus: AgentStatus | undefined; onOpen: () => void }) {
  const { fetchPaneConversation } = useMachineApi();
  const visible = usePageVisible();
  const [prompt, setPrompt] = useState<SentPrompt | null>(null);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void fetchPaneConversation(paneId).then((conversation) => {
      if (cancelled) return;
      const turn = conversation.source === "scrollback" ? undefined : conversation.turns[lastPromptIndex(conversation.turns)];
      setPrompt(turn === undefined ? null : promptOf(turn));
    }, () => { if (!cancelled) setPrompt(null); });
    return () => { cancelled = true; };
  }, [fetchPaneConversation, paneId, agentStatus, visible]);
  return prompt === null ? null : <LastPromptBar prompt={prompt} onOpen={onOpen} className="terminal-last-prompt" />;
}
