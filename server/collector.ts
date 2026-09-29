import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { HerdrError, sessionSnapshot, subscribeEvents, type EventFrame, type Subscription } from "./herdr/client.ts";

/**
 * Collects agent status for EVERY pane in the session, not just the attached ones.
 *
 * herdr's subscription surface (verified against protocol 22):
 * - `pane.agent_status_changed` REQUIRES a pane_id, but one connection carries any
 *   number of per-pane subscriptions, so all panes share a single status connection.
 * - A second `events.subscribe` request on an already-open connection is silently
 *   ignored: when the pane set changes the status connection must be re-opened with
 *   the full set (see `reconcile`).
 * - `pane.created` / `pane.closed` / `pane.exited` subscribe globally (no pane_id)
 *   and drive both the pane-set reconciliation and the structure broadcasts.
 * - `pane.focused` subscribes globally too, and fires for a tab or workspace brought to the
 *   front as well (`{event:"pane_focused", data:{type, pane_id, workspace_id}}`).
 *
 * - herdr (0.9.2+) closes a subscription that fell behind, after an `events_lost` error
 *   that never arrives when the socket's buffer is full (seen on 0.9.3): every connection
 *   here reopens itself on the close alone, and whatever it missed is read back from a
 *   snapshot taken once the new subscription has started (herdr's documented order).
 *
 * Status frames are flat (`{event:"pane.agent_status_changed", data:{pane_id, agent_status, ...}}`)
 * while structure frames carry a snake_case `data.type` - both shapes below parse only
 * what the live server actually sends.
 */

/** first retry after a subscription closed; doubles per closure that never started */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const BACKSTOP_INTERVAL_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 500;
/** retry delay when a reconcile's snapshot call fails (herdr busy/restarting) */
const SNAPSHOT_RETRY_MS = 5_000;

export interface StatusCollectorHandlers {
  /** `agent` is the agent herdr now sees in the pane (null: none) */
  onStatus: (paneId: string, status: AgentStatus, agent: string | null) => void;
  /**
   * Every pane as of each reconcile's snapshot. Status events only report changes, so
   * this is where a consumer learns the status a later change is measured against -
   * right after a restart, the first event of a pane would otherwise have no baseline.
   */
  onBaseline: (panes: readonly HerdrPane[]) => void;
  /**
   * Status events were lost (the status connection closed under us, e.g. herdr's
   * `events_lost`): this snapshot, taken after the new subscription started, is the
   * truth for every pane but the `newer` ones, which had an event since it was asked for.
   */
  onResync?: (panes: readonly HerdrPane[], newer: ReadonlySet<string>) => void;
  onPaneEnded: (paneId: string) => void;
  onStructureChange: () => void;
  /** herdr's focus moved onto this pane: whoever is at its terminal has it in front */
  onFocus?: (paneId: string) => void;
}

/** What the collector talks to, and how long it waits: tests swap both. */
export interface StatusCollectorDeps {
  subscribe: typeof subscribeEvents;
  snapshot: () => Promise<{ panes: HerdrPane[] }>;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  backstopMs: number;
  debounceMs: number;
  snapshotRetryMs: number;
}

const DEFAULT_DEPS: StatusCollectorDeps = {
  subscribe: subscribeEvents,
  snapshot: () => sessionSnapshot(),
  reconnectMinMs: RECONNECT_MIN_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  backstopMs: BACKSTOP_INTERVAL_MS,
  debounceMs: RECONCILE_DEBOUNCE_MS,
  snapshotRetryMs: SNAPSHOT_RETRY_MS,
};

export interface StatusCollector {
  stop: () => void;
}

/** A status frame's payload: flat fields, no wrapper object. */
export function parseStatusFrame(frame: EventFrame): { paneId: string; status: AgentStatus; agent: string | null } | null {
  if (frame.event !== "pane.agent_status_changed") return null;
  const data = frame.data as { pane_id?: unknown; agent_status?: unknown; agent?: unknown } | undefined;
  if (typeof data?.pane_id !== "string" || typeof data.agent_status !== "string") return null;
  return { paneId: data.pane_id, status: data.agent_status as AgentStatus, agent: typeof data.agent === "string" ? data.agent : null };
}

export type StructureEvent =
  | { kind: "pane-ended"; paneId: string }
  | { kind: "structure-changed" };

/** The pane a focus frame (`{data:{type:"pane_focused", pane_id}}`) brought to the front. */
export function parseFocusFrame(frame: EventFrame): string | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  return data?.type === "pane_focused" && typeof data.pane_id === "string" ? data.pane_id : null;
}

/** Structure frames: `{event:"pane_exited"|"pane_created"|"pane_closed", data:{type, pane_id?}}`. */
export function parseStructureFrame(frame: EventFrame): StructureEvent | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  switch (data?.type) {
    case "pane_exited":
      return typeof data.pane_id === "string" ? { kind: "pane-ended", paneId: data.pane_id } : null;
    case "pane_created":
    case "pane_closed":
      return { kind: "structure-changed" };
    default:
      return null;
  }
}

/**
 * A subscription that reopens itself when herdr closes it: at once, then backing off
 * while it keeps closing before it starts (herdr restarting). herdr closes a subscriber
 * that fell behind (`events_lost`, 0.9.2+) as well, and events sent meanwhile are gone:
 * `onRestart` runs once a connection opened after the first attempt is live, including
 * when the first never started (events since the caller's snapshot may be missed).
 */
function resilientSubscription(
  deps: StatusCollectorDeps,
  subscriptions: Parameters<typeof subscribeEvents>[0],
  onEvent: (frame: EventFrame) => void,
  onRestart: () => void,
  isStopped: () => boolean,
): { close: () => void } {
  let subscription: Subscription | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = deps.reconnectMinMs;
  let attempted = false;

  const open = (): void => {
    retryTimer = null;
    if (isStopped()) return;
    const retry = attempted;
    attempted = true;
    subscription = deps.subscribe(subscriptions, {
      onEvent,
      onStarted: () => {
        delay = deps.reconnectMinMs;
        if (retry) onRestart();
      },
      onError: logSubscriptionError,
      onClose: () => {
        subscription = null;
        if (isStopped()) return;
        retryTimer = setTimeout(open, delay);
        delay = Math.min(delay * 2, deps.reconnectMaxMs);
      },
    });
  };
  open();

  return {
    close() {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const current = subscription;
      subscription = null;
      current?.close();
    },
  };
}

/** herdr unreachable is expected while it restarts; anything else is worth a line. */
function logSubscriptionError(error: Error): void {
  const code = error instanceof HerdrError ? error.code : "error";
  if (code === "connect_failed" || code === "socket_error") return;
  console.error(`herdr events: ${code}: ${error.message}`);
}

export function startStatusCollector(handlers: StatusCollectorHandlers, overrides: Partial<StatusCollectorDeps> = {}): StatusCollector {
  const deps: StatusCollectorDeps = { ...DEFAULT_DEPS, ...overrides };
  let stopped = false;
  let statusSubscription: Subscription | null = null;
  let subscribedPaneIds = new Set<string>();
  let reconciling = false;
  let reconcilePending = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let backstopTimer: ReturnType<typeof setInterval> | null = null;
  let lifecycleSubscription: { close: () => void } | null = null;
  let focusSubscription: { close: () => void } | null = null;
  /** status events were lost: the next snapshot after a new subscription starts resyncs */
  let recovering = false;
  /** each status subscription's number: a resync counts only for the one still open */
  let statusGeneration = 0;
  /** the subscription that started while recovering: the next reconcile's snapshot resyncs */
  let resyncFor: number | null = null;
  /** counts status events; each pane keeps the count of its latest */
  let statusEvents = 0;
  const lastEventOf = new Map<string, number>();

  const STRUCTURE_SUBSCRIPTIONS = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
  ] as const;

  function closeStatusSubscription(): void {
    subscribedPaneIds = new Set();
    statusSubscription?.close();
    statusSubscription = null;
  }

  function openStatusSubscription(paneIds: readonly string[]): void {
    if (stopped || paneIds.length === 0) return;
    subscribedPaneIds = new Set(paneIds);
    const generation = ++statusGeneration;
    const subscription = deps.subscribe(
      paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
      {
        onEvent: (frame) => {
          const parsed = parseStatusFrame(frame);
          if (!parsed) return;
          lastEventOf.set(parsed.paneId, ++statusEvents);
          handlers.onStatus(parsed.paneId, parsed.status, parsed.agent);
        },
        // herdr's contract: subscribe, wait until it started, then snapshot. The snapshot
        // that chose these panes came before: one more closes the gap it leaves.
        onStarted: () => {
          if (statusSubscription !== subscription) return;
          if (recovering) resyncFor = generation;
          void reconcile();
        },
        onError: logSubscriptionError,
        // herdr answers a bad batch (e.g. a pane that vanished between snapshot and
        // subscribe) with an error frame and closes the socket, and closes a subscriber
        // that fell behind (`events_lost`): the whole set is re-subscribed from a fresh
        // snapshot, now rather than after the debounce, and what was missed is resynced
        onClose: () => {
          if (statusSubscription !== subscription || stopped) return;
          closeStatusSubscription();
          recovering = true;
          void reconcile();
        },
      },
    );
    statusSubscription = subscription;
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    if (reconciling) {
      // a reconcile is in flight: remember the request and re-run when it lands,
      // so an event arriving mid-reconcile can never be lost to the debounce
      reconcilePending = true;
      return;
    }
    reconciling = true;
    const resync = resyncFor;
    resyncFor = null;
    const askedAt = statusEvents;
    try {
      const snapshot = await deps.snapshot();
      if (stopped) return;
      handlers.onBaseline(snapshot.panes);
      // a snapshot asked for a subscription that closed meanwhile may predate what the next
      // one misses: recovery waits for that one's own snapshot
      if (resync !== null && resync === statusGeneration && statusSubscription !== null) {
        recovering = false;
        const newer = new Set([...lastEventOf].filter(([, seq]) => seq > askedAt).map(([paneId]) => paneId));
        handlers.onResync?.(snapshot.panes, newer);
        // clients learn statuses from events, and some were lost: they fetch again
        handlers.onStructureChange();
      }
      const paneIds = snapshot.panes.map((pane) => pane.pane_id);
      // gone before this snapshot; a pane heard of since may be too new for it
      for (const [paneId, seq] of lastEventOf) if (seq <= askedAt && !paneIds.includes(paneId)) lastEventOf.delete(paneId);
      const sameSet =
        paneIds.length === subscribedPaneIds.size && paneIds.every((id) => subscribedPaneIds.has(id));
      if (sameSet) return;
      closeStatusSubscription();
      openStatusSubscription(paneIds);
    } catch {
      if (resync !== null && resyncFor === null) resyncFor = resync;
      /* herdr unreachable or slow: retry shortly instead of waiting for the backstop */
      if (!stopped && reconcileTimer === null) {
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          void reconcile();
        }, deps.snapshotRetryMs);
      }
    } finally {
      reconciling = false;
      if (reconcilePending && !stopped) {
        reconcilePending = false;
        void reconcile();
      }
    }
  }

  function scheduleReconcile(): void {
    if (stopped || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void reconcile();
    }, deps.debounceMs);
  }

  lifecycleSubscription = resilientSubscription(
    deps,
    [...STRUCTURE_SUBSCRIPTIONS],
    (frame) => {
      const parsed = parseStructureFrame(frame);
      if (!parsed) return;
      if (parsed.kind === "pane-ended") handlers.onPaneEnded(parsed.paneId);
      else {
        handlers.onStructureChange();
        scheduleReconcile();
      }
    },
    // panes created or closed meanwhile were not heard of: learn them from a snapshot
    () => {
      handlers.onStructureChange();
      void reconcile();
    },
    () => stopped,
  );

  // Its own connection: a focus type an older herdr refuses must not cost pane exits.
  const onFocus = handlers.onFocus;
  if (onFocus !== undefined) {
    focusSubscription = resilientSubscription(
      deps,
      [{ type: "pane.focused" }],
      (frame) => {
        const paneId = parseFocusFrame(frame);
        if (paneId !== null) onFocus(paneId);
      },
      // a focus change missed meanwhile is gone for good: the next one is heard again
      () => {},
      () => stopped,
    );
  }

  void reconcile();
  backstopTimer = setInterval(() => void reconcile(), deps.backstopMs);

  return {
    stop() {
      stopped = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (backstopTimer !== null) clearInterval(backstopTimer);
      lifecycleSubscription?.close();
      focusSubscription?.close();
      closeStatusSubscription();
    },
  };
}
