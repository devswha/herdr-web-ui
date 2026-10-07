/**
 * What both sidebar lists share for Settings → Agents order and Quiet opened finishes: herdr's
 * state_change_seq per pane on each PC, kept in step with pushed statuses, and this browser's
 * record of the finishes looked at here. MachineSidebar owns it (`useSidebarActivityState`) and
 * provides it; the workspace rows and the Agents list read it (`useSidebarActivity`). The logic
 * itself is in lib/sidebarOrder.ts.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, PaneInfo } from "../../shared/protocol.ts";
import { useSettings } from "./settings.ts";
import { liveSeqs, loadSeen, markSeen, newSeqMemory, pruneSeen, saveSeen, seedSeen, shownStatus, type SeenRecord, type SeqMemory } from "./sidebarOrder.ts";

export interface SidebarActivity {
  /** herdr's state_change_seq per pane on a PC, a pushed status change dated at once */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the status a row draws for a pane: with Quiet opened finishes on, a DONE looked at here reads as ready */
  status(machineId: string, pane: Pick<PaneInfo, "pane_id" | "agent_status">): AgentStatus | undefined;
}

const NO_SEQS: ReadonlyMap<string, number> = new Map();
const SidebarActivityContext = createContext<SidebarActivity>({ seqs: () => NO_SEQS, status: (_machineId, pane) => pane.agent_status });
export const SidebarActivityProvider = SidebarActivityContext.Provider;
export const useSidebarActivity = (): SidebarActivity => useContext(SidebarActivityContext);

export function useSidebarActivityState(machines: readonly Machine[], selectedMachineId: string, selectedPaneId: string | null): SidebarActivity {
  const { settings } = useSettings();
  const memories = useRef(new Map<string, SeqMemory>());
  const seqsByMachine = useMemo(() => new Map(machines.map((machine) => {
    let memory = memories.current.get(machine.id);
    if (!memory) memories.current.set(machine.id, memory = newSeqMemory());
    return [machine.id, liveSeqs(machine.snapshot, memory)] as const;
  })), [machines]);

  // The pane on screen, while the page is visible, is looked at at its current counter. A PC's
  // first record counts everything open as looked at, so turning the setting on starts quiet.
  const [seen, setSeen] = useState<ReadonlyMap<string, SeenRecord>>(() => new Map());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    if (!settings.quietOpenedDone) return;
    setSeen((current) => {
      let next: Map<string, SeenRecord> | null = null;
      for (const machine of machines) {
        // a PC that is away keeps its record: its saved roster says nothing new
        if (!machine.snapshot || machine.state !== "connected") continue;
        const seqs = seqsByMachine.get(machine.id) ?? NO_SEQS;
        const before = current.get(machine.id);
        let record = before ?? loadSeen(machine.id) ?? seedSeen(machine.snapshot.panes, seqs);
        const seq = machine.id === selectedMachineId && selectedPaneId && pageVisible ? seqs.get(selectedPaneId) : undefined;
        if (selectedPaneId && seq !== undefined) record = markSeen(record, selectedPaneId, seq);
        record = pruneSeen(record, machine.snapshot.panes);
        if (record !== before) (next ??= new Map(current)).set(machine.id, record);
      }
      return next ?? current;
    });
  }, [settings.quietOpenedDone, machines, seqsByMachine, selectedMachineId, selectedPaneId, pageVisible]);
  useEffect(() => {
    for (const [machineId, record] of seen) saveSeen(machineId, record);
  }, [seen]);

  return useMemo<SidebarActivity>(() => ({
    seqs: (machineId) => seqsByMachine.get(machineId) ?? NO_SEQS,
    status: (machineId, pane) => settings.quietOpenedDone
      ? shownStatus(pane, seqsByMachine.get(machineId) ?? NO_SEQS, seen.get(machineId) ?? null)
      : pane.agent_status,
  }), [seqsByMachine, seen, settings.quietOpenedDone]);
}
