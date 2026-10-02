import type { OmoTask } from "../../shared/protocol.ts";

/** How long a task has run: until now while it runs, until it ended otherwise; null when unknown. */
export function taskElapsedMs(task: OmoTask, now: number): number | null {
  const started = task.started_at === null ? NaN : Date.parse(task.started_at);
  const ended = task.status === "running" ? now : task.ended_at === null ? NaN : Date.parse(task.ended_at);
  return Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
}

/** How far the PC's clock is ahead of this browser's, from the time it answered with; 0 when unknown. */
export function clockOffsetMs(serverTime: string | null, receivedAt: number): number {
  const server = serverTime === null ? NaN : Date.parse(serverTime);
  return Number.isFinite(server) ? server - receivedAt : 0;
}

/** `8s`, `4m 12s`, `1h 3m` */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
