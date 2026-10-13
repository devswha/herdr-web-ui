import { useEffect, useRef } from "react";
import type { AgentStatus } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { ApiError, routeMissing } from "../lib/api.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { seenStep } from "../lib/viewedSeen.ts";
import { usePageVisible } from "../lib/visibility.ts";

/**
 * Tells herdr, on the PC of its MachineContext, that a finished agent open here was seen
 * (lib/viewedSeen.ts). `paneId` is the pane the user opened, null while the app picked it.
 */
export function ViewedPaneSeen({ paneId, status, covered }: { paneId: string | null; status: AgentStatus | undefined; covered: boolean }): null {
  const machineId = useMachineId();
  const { focusPane } = useMachineApi();
  const visible = usePageVisible();
  const told = useRef<string | null>(null);
  const key = paneId === null ? null : paneStorageId(machineId, paneId);
  useEffect(() => {
    const step = seenStep(told.current, key, status, visible && !covered);
    told.current = step.told;
    if (!step.tell || paneId === null) return;
    focusPane(paneId).catch((error: unknown) => {
      // a bridge from before the route, a watching device and a pane closed meanwhile are expected
      if (routeMissing(error) || error instanceof ApiError && (error.code === "read_only" || error.code === "pane_not_found")) return;
      console.warn("marking a viewed pane seen failed", error);
    });
  }, [key, status, visible, covered, paneId, focusPane]);
  return null;
}
