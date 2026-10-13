/**
 * A part of the app fetched the first time it is needed (KaTeX, Mermaid). Its file is named after
 * the build, so a tab still running the build before a server update asks for one the server no
 * longer has. Such a failure is told (onLazyChunkFailure), where the update line can ask the server
 * at once and offer the reload, and the next use asks again instead of keeping the failure for
 * the page's life: a phone that was only offline gets it once it is back.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

/** Hears every failed load; returns its own removal. */
export function onLazyChunkFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** `load` run once while it is pending or has loaded, and again after a failure. */
export function lazyChunk<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null;
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* one listener does not cost the others */ }
      }
      throw error;
    });
    return pending;
  };
}
