import type { AppLink } from "./deepLink.ts";

export type NotificationPaneView = "chat" | "terminal";
export type NotificationTarget = { machine_id: string; pane_id: string; view?: NotificationPaneView };
type Target = NotificationTarget;
type Select = (target: Target) => void;

export function notificationTargetFromSearch(search: string): NotificationTarget | null {
  const params = new URLSearchParams(search);
  const pane_id = params.get("pane");
  const view = params.get("view");
  if (!pane_id || (view !== "chat" && view !== "terminal")) return null;
  return { machine_id: params.get("machine") ?? "local", pane_id, view };
}

export function notificationViewForPane(target: NotificationTarget | null, machineId: string, paneId: string | null): NotificationPaneView | null {
  if (!target || paneId === null || target.machine_id !== machineId || target.pane_id !== paneId) return null;
  return target.view ?? null;
}
/** The roster is in and does not list this PC: it was removed since (the roster lists every PC set up, connected or not). */
export function machineMissing(roster: readonly { id: string }[], machineId: string): boolean {
  return roster.length > 0 && !roster.some((machine) => machine.id === machineId);
}

type RosterMachine = { id: string; snapshot?: { panes: readonly { pane_id: string }[] } | null };

/**
 * Where a tapped notification lands. A PC no longer set up: this PC, with a word in the header.
 * A pane the roster lists: selected at once. Anything not yet known (no roster yet, the PC's panes
 * not in, the pane not among them) waits as a link to that pane does, settled against the PC's
 * roster with the same notes (lib/deepLink.ts resolveLink).
 */
export function notificationLanding(roster: readonly RosterMachine[], target: NotificationTarget): { kind: "missing" } | { kind: "select" } | { kind: "link"; link: AppLink } {
  if (machineMissing(roster, target.machine_id)) return { kind: "missing" };
  const machine = roster.find((candidate) => candidate.id === target.machine_id);
  if (machine?.snapshot?.panes.some((pane) => pane.pane_id === target.pane_id)) return { kind: "select" };
  return { kind: "link", link: { machine: target.machine_id, workspace: null, pane: target.pane_id, view: target.view ?? null, settings: null } };
}

type MessageSource = { addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void };

/** Keep the newest target until App is ready, then deliver new selections directly. */
export function notificationTargets(source?: MessageSource): (select: Select) => () => void {
  let pending: Target | null = null;
  let consumer: Select | null = null;
  source?.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; pane_id?: unknown; machine_id?: unknown; view?: unknown } | null;
    if (data?.type !== "select-pane" || typeof data.pane_id !== "string") return;
    const target: Target = {
      machine_id: typeof data.machine_id === "string" ? data.machine_id : "local",
      pane_id: data.pane_id,
    };
    if (data.view === "chat" || data.view === "terminal") target.view = data.view;
    if (consumer) consumer(target);
    else pending = target;
  });
  return (select) => {
    consumer = select;
    const target = pending;
    pending = null;
    if (target) select(target);
    return () => { if (consumer === select) consumer = null; };
  };
}

// Browser messages can arrive after document loading but before React's effect.
// Install this listener while App's module loads, before creating its root.
export const onNotificationTarget = notificationTargets(
  typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
);
