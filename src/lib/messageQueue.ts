/** Held messages are explicitly sent, never dispatched by reconnects or status changes. */
export interface HeldMessage { id: string; text: string }
type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
let serial = 0;
const newId = () => `${Date.now().toString(36)}-${(++serial).toString(36)}`;

/** Target-scoped cache also lets an ACK remove its own item after the user switches panes. */
export class MessageQueueStore {
  private queues = new Map<string, HeldMessage[]>();
  private listeners = new Set<() => void>();
  private pending = new Set<string>();
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  isSending(id: string): boolean { return this.pending.has(id); }
  beginSend(owner: string, id: string): boolean {
    if (this.pending.has(id)) return false;
    this.pending.add(id);
    this.write(owner, [...this.read(owner)]);
    return true;
  }
  endSend(owner: string, id: string): void {
    this.pending.delete(id);
    this.write(owner, [...this.read(owner)]);
  }
  constructor(private storage: () => QueueStorage = () => window.localStorage) {}

  read(owner: string): HeldMessage[] {
    const cached = this.queues.get(owner);
    if (cached) return cached;
    let raw: string | null = null;
    try { raw = this.storage().getItem(`herdr-web-ui:queue:${owner}`); } catch { /* private mode */ }
    let messages: HeldMessage[] = raw ? [{ id: newId(), text: raw }] : [];
    try {
      const data = JSON.parse(raw ?? "null");
      if (data?.version === 1 && Array.isArray(data.messages)) {
        const ids = new Set<string>();
        messages = data.messages.filter((item: unknown): item is HeldMessage => {
          if (!item || typeof item !== "object") return false;
          const value = item as HeldMessage;
          if (typeof value.id !== "string" || typeof value.text !== "string" || ids.has(value.id)) return false;
          ids.add(value.id); return true;
        });
      }
    } catch { /* previous versions stored a single plain-text message */ }
    this.queues.set(owner, messages);
    return messages;
  }

  private write(owner: string, messages: HeldMessage[]): void {
    this.queues.set(owner, messages);
    try {
      const key = `herdr-web-ui:queue:${owner}`;
      if (messages.length) this.storage().setItem(key, JSON.stringify({ version: 1, messages }));
      else this.storage().removeItem(key);
    } catch { /* keep the queue in memory when storage is unavailable */ }
    for (const listener of this.listeners) listener();
  }

  add(owner: string, text: string): void {
    this.write(owner, [...this.read(owner), { id: newId(), text }]);
  }
  edit(owner: string, id: string, text: string): void {
    this.write(owner, this.read(owner).map((message) => message.id === id ? { ...message, text } : message));
  }
  remove(owner: string, id: string): void {
    this.write(owner, this.read(owner).filter((message) => message.id !== id));
  }
}

// Machine switches remount the terminal; outstanding sends must share the same owner cache.
export const messageQueues = new MessageQueueStore();
