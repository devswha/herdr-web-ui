/** Saved conversations belong to a PC and outlive its terminal panes. */
export interface SavedConversation {
  readonly id: string;
  readonly agent: string;
  readonly title: string;
  readonly cwd: string;
  readonly updated_at: number;
  readonly session_id: string | null;
  readonly pane_id: string | null;
  readonly state: "open" | "closed" | "unavailable";
  readonly can_resume: boolean;
  readonly error: string | null;
}

export interface ConversationHistoryResponse {
  readonly conversations: readonly SavedConversation[];
}

export interface ResumeConversationResponse {
  readonly pane_id: string;
  readonly workspace_id: string;
}
