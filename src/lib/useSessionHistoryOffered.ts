import { useEffect, useState } from "react";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

/**
 * Whether this PC's bridge lists earlier sessions (GET /api/sessions/history): this PC's bridge
 * does; another PC's is asked once while it is online, without listing anything (a bridge from
 * before the route answers 404), and again whenever it comes back. The workspace row's menu and
 * the chat's /resume offer the list only where it is.
 */
export function useSessionHistoryOffered(online: boolean): boolean {
  const machineId = useMachineId();
  const { sessionHistoryOffered } = useMachineApi();
  const [offered, setOffered] = useState(machineId === LOCAL_MACHINE);
  useEffect(() => {
    if (machineId === LOCAL_MACHINE || !online) return;
    let live = true;
    sessionHistoryOffered().then((answer) => { if (live) setOffered(answer); }, () => { /* not reached: asked again when it is back */ });
    return () => { live = false; };
  }, [machineId, online, sessionHistoryOffered]);
  return offered;
}
