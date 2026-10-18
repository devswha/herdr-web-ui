import type { SessionSnapshot } from "./protocol.ts";

/** Internal workstation identity used by pane/draft storage and the split canvas. */
export const LOCAL_MACHINE = "local";
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "error";
export interface Machine {
  id: string;
  name: string;
  kind: "local";
  enabled: boolean;
  state: MachineState;
  error: string | null;
  snapshot: SessionSnapshot | null;
}
export interface HerdrIdentity {
  version: string;
  protocol: number;
  terminal_attach?: boolean;
  terminal_mirror?: boolean;
}
/** Keep existing local draft keys across operator-managed upgrades. */
export function paneStorageId(_machineId: string, paneId: string): string { return paneId; }
export function machinePath(machineId: string, path: string): string {
  if (machineId !== LOCAL_MACHINE) throw new Error("This app serves only its host workstation");
  return `/api/${path}`;
}
