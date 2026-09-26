import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { herdrSocketPath } from "./herdr/client.ts";

/**
 * `done` for agents herdr loses track of on the way, and for the pane herdr has focused.
 *
 * herdr reports `done` for an agent that went back to idle while its pane was not being
 * looked at (not focused), and `idle` once it is. It follows the agent it saw working, so
 * an agent recognised from its screen and processes rather than an integration can
 * finish as plain `idle`: an omo pane reads `pi/working`, then `claude/unknown` while
 * omo's claude child runs, then `claude/idle` (live-traced with omo 5.0), and the
 * working agent herdr knew never finished. The sidebar said READY, and no alert came.
 *
 * herdr's focus is also no sign that anyone saw a finish. It is the pane its terminal
 * last had in front, and it stays there while the user works from a browser or a phone,
 * which never move it: an agent finishing in that pane finished as plain `idle`, READY
 * and no alert, whoever was looking.
 *
 * So each pane's "worked since it was last idle" is kept here, and an idle that follows
 * work is reported as `done` until the pane works again or focus moves onto it (`seen`):
 * what herdr itself reports for an agent it did not lose in a pane it has not in front.
 * And the `unknown` in between, while an agent is still there, is reported as `working`
 * (omo's whole turn read `unknown`, and the sidebar showed no RUN).
 *
 * herdr keeps its own `done` across a restart of this server; what is kept here was lost
 * with it, and every omo or gjc pane that had finished read READY again after an update.
 * So the finished panes are kept in a file too, for the herdr they were seen in: a herdr
 * started anew reuses pane ids for other panes, and its socket is then another file. The
 * panes still working are not: what became of them while this server was down (finished,
 * and seen at herdr's terminal?) is unknown, and a DONE nobody needs is an alert too.
 */
export class CompletionTracker {
  /** panes that worked (or were blocked) since they were last idle, done or seen */
  private readonly worked = new Set<string>();
  /** panes reported here as `done` while herdr says `idle` */
  private readonly finished = new Set<string>();
  /** what the file holds, so it is written only when that changes */
  private saved = "";

  /**
   * `file` keeps the state across restarts (none: memory only); `herdr` names the herdr
   * the panes live in, the identity of its socket file by default.
   */
  constructor(private readonly file: string | null = null, private readonly herdr: () => string | null = herdrSocketId) {
    if (file === null) return;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { herdr?: unknown; finished?: unknown };
      const current = herdr();
      if (current === null || state.herdr !== current) return;
      for (const pane of Array.isArray(state.finished) ? state.finished : []) if (typeof pane === "string") this.finished.add(pane);
      this.saved = this.serialize(current);
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /** A status change as herdr sent it, to the status to report. */
  observe(paneId: string, status: AgentStatus, agent: string | null = null): AgentStatus {
    const reported = this.settle(paneId, status, agent);
    this.save();
    return reported;
  }

  /**
   * Focus moved onto a pane: a finish reported here as `done` has been seen and is
   * `idle` again, as herdr does for its own. True when that changed what the pane reads.
   */
  seen(paneId: string): boolean {
    const changed = this.finished.delete(paneId);
    if (changed) this.save();
    return changed;
  }

  /** A snapshot as the browser should see it: idle panes this tracker saw finish read `done`. */
  present(snapshot: SessionSnapshot): SessionSnapshot {
    const statuses = new Map<string, AgentStatus>();
    for (const pane of snapshot.panes) {
      const status = this.settle(pane.pane_id, pane.agent_status, pane.agent ?? null);
      if (status !== pane.agent_status) statuses.set(pane.pane_id, status);
    }
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
    for (const pane of [...this.worked, ...this.finished]) if (!live.has(pane)) this.forget(pane);
    this.save();
    if (statuses.size === 0) return snapshot;
    return {
      ...snapshot,
      panes: snapshot.panes.map((pane) => statuses.has(pane.pane_id) ? { ...pane, agent_status: statuses.get(pane.pane_id)! } : pane),
      agents: snapshot.agents.map((agent) => statuses.has(agent.pane_id) ? { ...agent, agent_status: statuses.get(agent.pane_id)! } : agent),
    };
  }

  forget(paneId: string): void {
    this.worked.delete(paneId);
    this.finished.delete(paneId);
    this.save();
  }

  private serialize(herdr: string): string {
    return JSON.stringify({ herdr, finished: [...this.finished].sort() });
  }

  /** Written whole, and only on a change: a crash mid-write must not leave half a file. */
  private save(): void {
    if (this.file === null) return;
    const herdr = this.herdr();
    if (herdr === null) return;
    const state = this.serialize(herdr);
    if (state === this.saved) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, state, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.saved = state;
    } catch (error) {
      // a full disk costs the state after a restart, never the status itself
      console.error(`completion state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private settle(paneId: string, status: AgentStatus, agent: string | null): AgentStatus {
    switch (status) {
      case "working":
      case "blocked":
        this.worked.add(paneId);
        this.finished.delete(paneId);
        return status;
      case "done":
        this.worked.delete(paneId);
        this.finished.delete(paneId);
        return status;
      case "idle":
        if (this.worked.delete(paneId)) this.finished.add(paneId);
        return this.finished.has(paneId) ? "done" : status;
      default:
        // `unknown` right after work, with an agent still there, is the work going on under
        // another identity; with no agent left, the pane is a shell again
        if (!this.worked.has(paneId)) return status;
        if (agent === null) {
          this.worked.delete(paneId);
          return status;
        }
        return "working";
    }
  }
}

/** The herdr server this one talks to, as its socket file: a herdr started anew has another. */
function herdrSocketId(): string | null {
  try {
    const stat = statSync(herdrSocketPath());
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}
