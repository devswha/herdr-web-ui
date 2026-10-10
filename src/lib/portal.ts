import { useCallback, useEffect, useRef, useState } from "react";
import type { PortalStatus } from "../../shared/protocol.ts";
import { fetchPortal, requestPortal } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/** the address appears or goes with these, so they are followed closely */
export const PORTAL_SETTLING: ReadonlySet<PortalStatus["phase"]> = new Set(["installing", "starting", "stopping"]);

/**
 * Portal's public address, which the server opens on its own PC (server/portal.ts). Asked while
 * Settings → Phone & devices is open.
 */
export function usePortal() {
  const [status, setStatus] = useState<PortalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // the component's own lifetime, not the poll's: a page hidden while the request is on its way must still get the answer
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const visible = usePageVisible();
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      let delay = 15_000;
      try {
        const next = await fetchPortal();
        if (!stopped) setStatus((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        if (PORTAL_SETTLING.has(next.phase)) delay = 1_500;
      } catch { /* an older server has no such route, and a restart must not erase the last answer */ }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, visible]);

  const request = useCallback(async (action: "install" | "start" | "stop", relay?: string) => {
    setPending(true); setError(null);
    try {
      await requestPortal(action, relay);
      if (mounted.current) setRefresh((value) => value + 1);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally { if (mounted.current) setPending(false); }
  }, []);
  return { status, error, pending, request };
}
