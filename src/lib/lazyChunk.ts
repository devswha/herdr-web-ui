/**
 * A part of the app fetched the first time it is needed (KaTeX, Mermaid). Its file is named after
 * the build, so a tab still running the build before a server update asks for one the server no
 * longer has, and a phone offline at that moment cannot reach it either. A failed load is not
 * tried again: Chrome keeps a failed import's answer for the page's life without fetching again,
 * and Vite's loader skips a stylesheet it tried before, so a second try could only fail again or
 * draw without its styles. The failure is told instead (onLazyChunkFailure), and the app offers
 * a reload, the one thing that fetches it again.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let failed = false;

/** Hears every failed load; returns its own removal. */
export function onLazyChunkFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a part of the app failed to load in this page. */
export function lazyChunkFailed(): boolean {
  return failed;
}

/** `load` run once: what it gave, or the failure it ended in, for the page's life. */
export function lazyChunk<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      failed = true;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener does not cost the others */ }
      }
      throw error;
    });
    return pending;
  };
}
