import type { OmoProgress } from "../shared/protocol.ts";
import { OmoProgressRecords } from "./omo-progress-records.ts";

export interface OmoProgressSession {
  readonly sessionId: string;
  readonly path: string;
  readonly startedAt: number | null;
}

/** Progress from the session file only: the checklist and whether a turn is running. */
export class OmoProgressReader {
  constructor(private readonly records = new OmoProgressRecords()) {}

  read(session: OmoProgressSession): OmoProgress {
    const record = this.records.read(session.path);
    const stale = record.turn.at !== null && session.startedAt !== null && record.turn.at < session.startedAt - 2000;
    const activity: OmoProgress["activity"] = stale ? "idle" : record.turn.status ?? "unknown";
    // A resumed checklist is still the session's plan. Its task status is independent
    // of whether this process is currently running a turn.
    return { session_id: session.sessionId, todos: record.todos, activity };
  }
}

const reader = new OmoProgressReader();
export const omoProgress = (session: OmoProgressSession): OmoProgress => reader.read(session);
