import { useEffect, useState } from "react";
import { lazyChunkFailed, onLazyChunkFailure } from "../lib/lazyChunk.ts";
import { useT } from "../lib/i18n.ts";
import "./ChunkFailureNotice.css";

export function ChunkFailureNotice() {
  const t = useT();
  const [failed, setFailed] = useState(lazyChunkFailed);
  // subscribed first, then read: a failure between the first render and the subscription is kept
  useEffect(() => { const stop = onLazyChunkFailure(() => setFailed(true)); setFailed(lazyChunkFailed()); return stop; }, []);
  if (!failed) return null;
  return <div className="chunk-failure-notice" role="status">
    <span>{t("Part of the app could not load. Save unsent drafts, then reload.")}</span>
    <button type="button" className="btn" onClick={() => window.location.reload()}>{t("Reload app")}</button>
  </div>;
}