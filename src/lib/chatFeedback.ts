import type { AgentStatus, ConversationTurn } from "../../shared/protocol.ts";

/** Send/queue acceptance says nothing about agent work. Only a live status can say it is thinking. */
export function showThinking({ connected, ended, agentStatus, lastRole }: {
  connected: boolean;
  ended: boolean;
  agentStatus: AgentStatus | undefined;
  lastRole: ConversationTurn["role"] | undefined;
}): boolean {
  return connected && !ended && agentStatus === "working" && lastRole !== "assistant";
}
