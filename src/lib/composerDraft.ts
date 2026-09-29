/** Drafts and in-flight sends belong to their pane, even while its composer is unmounted. */
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface Draft { text: string; sending: boolean }
export class ComposerDraftStore {
  private drafts = new Map<string, Draft>();
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private storage: () => DraftStorage = () => window.localStorage) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify(): void { for (const listener of this.listeners) listener(); }
  read(key: string): Draft {
    let draft = this.drafts.get(key);
    if (!draft) {
      let text: string | null = null;
      try { text = this.storage().getItem(key); } catch { /* private mode */ }
      this.saved.set(key, text);
      draft = { text: text ?? "", sending: false };
      this.drafts.set(key, draft);
    }
    return draft;
  }
  refresh(key: string): void {
    if (this.unsaved.has(key)) return;
    const draft = this.read(key);
    try {
      const text = this.storage().getItem(key);
      if (text === this.saved.get(key)) return;
      this.saved.set(key, text);
      this.drafts.set(key, { ...draft, text: text ?? "" });
      this.notify();
    } catch { /* retain the in-memory draft */ }
  }
  set(key: string, value: string | ((previous: string) => string)): void {
    const draft = this.read(key);
    const text = typeof value === "string" ? value : value(draft.text);
    this.drafts.set(key, { ...draft, text });
    try {
      if (text) this.storage().setItem(key, text);
      else this.storage().removeItem(key);
      this.saved.set(key, text || null);
      this.unsaved.delete(key);
    } catch { this.unsaved.add(key); }
    this.notify();
  }
  begin(key: string): boolean {
    const draft = this.read(key);
    if (draft.sending) return false;
    this.drafts.set(key, { ...draft, sending: true });
    this.notify();
    return true;
  }
  end(key: string): void {
    this.drafts.set(key, { ...this.read(key), sending: false });
    this.notify();
  }
  /** Remove only the acknowledged prefix; edits within the sent text stay unsent. */
  settle(key: string, sent: string): { text: string; edited: boolean } {
    this.refresh(key);
    const current = this.read(key).text;
    const edited = current !== sent && !current.startsWith(sent);
    const text = edited ? current : current.slice(sent.length);
    this.set(key, text);
    return { text, edited };
  }
}
export const composerDrafts = new ComposerDraftStore();
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key?.startsWith("herdr-web-ui:composer-draft:")) composerDrafts.refresh(event.key);
});
