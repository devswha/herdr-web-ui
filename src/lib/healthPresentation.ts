/**
 * What the header says about a PC's herdr, kept apart from what that herdr can do.
 *
 * A health read that fails is no proof that herdr stopped: the web server may be restarting, the
 * phone may have dropped a request, herdr may be busy for one poll. So one failed read in a row
 * makes the status unknown (the last answer's details stay named), and a second makes it
 * unavailable. Neither changes the PC's capabilities: those are the last answer the PC gave, and
 * only another answer replaces them, so a Windows herdr's `terminal_attach: false` is never
 * forgotten into the attach-capable default by a failed read. Reads are numbered as they start; one
 * that completes after a newer read has been taken in is dropped, whatever it says.
 */

export type HealthFreshness = "pending" | "fresh" | "unknown" | "unavailable";
export type HealthAnswer<T> = { ok: true; value: T } | { ok: false };

export interface MachineHealth<T> {
  /** the PC's latest answer: its capabilities, until another answer replaces them */
  readonly confirmed: T | null;
  /** completed reads in a row that failed since that answer (or since the page opened) */
  readonly failures: number;
  /** the newest read taken in; an older one that completes later is dropped */
  readonly read: number;
}

export type HealthBook<T> = ReadonlyMap<string, MachineHealth<T>>;

/** failed reads in a row after which the header says unavailable rather than unknown */
export const UNAVAILABLE_AFTER = 2;

const NOTHING_YET: MachineHealth<never> = { confirmed: null, failures: 0, read: 0 };

export function machineHealth<T>(book: HealthBook<T>, machineId: string): MachineHealth<T> {
  return book.get(machineId) ?? NOTHING_YET;
}

/** Takes in one completed read of one PC; `read` is the number the read got as it started. */
export function applyHealthRead<T>(book: HealthBook<T>, machineId: string, read: number, answer: HealthAnswer<T>): HealthBook<T> {
  const current = machineHealth(book, machineId);
  if (read <= current.read) return book;
  const next = new Map(book);
  next.set(machineId, answer.ok
    ? { confirmed: answer.value, failures: 0, read }
    : { confirmed: current.confirmed, failures: current.failures + 1, read });
  return next;
}

export function healthFreshness(health: Pick<MachineHealth<unknown>, "confirmed" | "failures">): HealthFreshness {
  if (health.failures === 0) return health.confirmed === null ? "pending" : "fresh";
  return health.failures < UNAVAILABLE_AFTER ? "unknown" : "unavailable";
}
