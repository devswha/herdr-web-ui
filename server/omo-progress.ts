import type { OmoProgress } from "../shared/protocol.ts";
import { OmoControl } from "./omo-control.ts";
import { OmoProgressRecords } from "./omo-progress-records.ts";

export interface OmoProgressSession {
  readonly sessionId: string;
  readonly path: string;
  readonly startedAt: number | null;
}

/** Exact live embedded-editor status, not quoted transcript prose. Require the spinner,
 * top border, following prompt and bottom border near the bottom of the visible screen.
 * Standalone/wrapped/preview statuses are ambiguous and deliberately remain unknown.
 */
export function visibleCompaction(screen: string): "compacting" | "unknown" | null {
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/).map((line) => line.trimEnd());
  const label = "(?:Compacting context|Context overflow detected, compacting|Compacting before next prompt|Auto-compacting|Compacting)\\.\\.\\. \\(esc to cancel\\)";
  const live = new RegExp(`^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ${label} ─+$`);
  const quoted = new Set<number>();
  let fence = false;
  lines.forEach((line, at) => {
    if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
    if (fence) quoted.add(at);
  });
  for (let at = Math.max(0, lines.length - 12); at < lines.length - 2; at++) {
    if (quoted.has(at) || !live.test(lines[at] ?? "")) continue;
    if (!/^❯(?: |$)/.test(lines[at + 1] ?? "")) continue;
    const bottom = lines.slice(at + 2, Math.min(lines.length, at + 7)).findIndex((line) => /^─{5,}$/.test(line));
    if (bottom !== -1 && !lines.slice(at + 3 + bottom).some((line) => /^❯(?: |$)/.test(line))) return "compacting";
  }
  return lines.some((line) => /(?:compacting|Compacting).*esc to cancel/.test(line)) ? "unknown" : null;
}

export class OmoProgressReader {
  constructor(
    private readonly records = new OmoProgressRecords(),
    private readonly control = new OmoControl(),
  ) {}

  async read(session: OmoProgressSession, visible: () => Promise<string>): Promise<OmoProgress> {
    const record = this.records.read(session.path);
    const native = await this.control.activity(session.sessionId);
    let activity: OmoProgress["activity"] = native ?? "unknown";
    if (native === null) {
      const screen = await visible().catch(() => null);
      const compaction = screen === null ? "unknown" : visibleCompaction(screen);
      const stale = record.turn.at !== null && session.startedAt !== null && record.turn.at < session.startedAt - 2000;
      activity = compaction ?? (stale ? "idle" : record.turn.status ?? "unknown");
    }
    // A resumed checklist is still the session's plan. Its task status is independent
    // of whether this process is currently running a turn.
    return { session_id: session.sessionId, todos: record.todos, activity };
  }
}

const reader = new OmoProgressReader();
export const omoProgress = (session: OmoProgressSession, visible: () => Promise<string>): Promise<OmoProgress> =>
  reader.read(session, visible);
