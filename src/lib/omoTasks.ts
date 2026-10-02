import type { OmoTask } from "../../shared/protocol.ts";

/** How long something has run: until now while it runs, until it ended otherwise; null when unknown. */
export function spanMs(startedAt: string | null, endedAt: string | null, running: boolean, now: number): number | null {
  const started = startedAt === null ? NaN : Date.parse(startedAt);
  const ended = running ? now : endedAt === null ? NaN : Date.parse(endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

export function taskElapsedMs(task: OmoTask, now: number): number | null {
  return spanMs(task.started_at, task.ended_at, task.status === "running", now);
}

/** `8s`, `4m 12s`, `1h 3m` */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
