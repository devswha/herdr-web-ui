/**
 * Each pane's terminal and who shows it: the attachment every client of a pane shares, the one
 * still being created, the one whose process is still exiting, and the output each client is
 * sent. The pane's agent conversation is watched while a client that shows the pane asks for it.
 */
import type { ServerMessage } from "../../shared/protocol.ts";
import { ConversationMonitor } from "../conversation-monitor.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS, wireBytes } from "../output-window.ts";
import type { PtySession } from "../pty/session.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { createSpawnAttachment, type PaneAttachment } from "./terminal-process.ts";

/** joins this close together share one repaint: a reconnect brings every tab back at once */
const REPAINT_COALESCE_MS = 50;
/**
 * The least time between two repaints of one pane: each costs every client of it a whole screen,
 * and a joiner in the cooldown is served by the next one instead (a flapping phone, quick switches).
 */
const REPAINT_MIN_INTERVAL_MS = 1000;

/**
 * The server's terminals. `stopped` is read through a getter, as `stop()` sets it later, and `end`
 * is called through one, as the connections are built after the terminals.
 */
export function createTerminalRegistry({ options, clients, stopped, terminalAttach, holdFor, heldRetry, retryFor, relookupFor, holdPending, holdPendingPane, end }: {
  options: { codexHome?: string; devinDbPath?: string; opencodeDb?: string; hermesHome?: string; grokHome?: string };
  clients: Set<Client>;
  stopped: () => boolean;
  terminalAttach: () => Promise<boolean>;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
  holdPending: (owner: Client, paneId?: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  end: (client: Client, reason: "stalled" | "revoked" | "closed") => void;
}) {
  const attachments = new Map<string, PaneAttachment>();

  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();

  const conversations = new ConversationMonitor((paneId, signature) => {
    for (const client of clients) {
      if (!connectionOf(client).closing && client.readyState === WebSocket.OPEN && client.data.attached.has(paneId) && client.data.conversationInterests.has(paneId)) {
        send(client, { type: "conversation-changed", pane_id: paneId, signature });
      }
    }
  }, options.codexHome, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome);

  function releaseConversation(paneId: string): void {
    for (const client of clients) {
      if (!connectionOf(client).closing && client.readyState === WebSocket.OPEN && client.data.attached.has(paneId) && client.data.conversationInterests.has(paneId)) return;
    }
    conversations.unwatch(paneId);
  }

  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment?.pty) return;
    let paused = false;
    for (const client of attachment.clients) {
      const window = client.data.output.get(paneId);
      const buffered = client.getBufferedAmount();
      if (window) {
        // an ACK client: measured by its ACK progress, and a joiner draining its replay never pauses the pty
        const verdict = window.check(buffered);
        if (verdict === "stop") end(client, "stalled");
        else if (verdict === "pause") paused = true;
        continue;
      }
      // a client without ACKs has only its transport queue to go by
      const blocked = buffered >= OUTPUT_HIGH_BYTES;
      if (!blocked) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) {
        end(client, "stalled");
      } else {
        paused = true;
      }
    }
    if (attachments.get(paneId) !== attachment) return;
    if (paused) attachment.pty.pause();
    else attachment.pty.resume();
  }

  function sendOutput(client: Client, paneId: string, data: string): void {
    const window = client.data.output.get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || client.getBufferedAmount() >= OUTPUT_HARD_BYTES) {
      end(client, "stalled");
      return;
    }
    send(client, {
      type: "pty-data", pane_id: paneId, data,
      ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes, wireBytes(data)) } } : {}),
    });
  }

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  const { spawnAttachment } = createSpawnAttachment({ attachments, retiringAttachments, terminalAttach, isStopped: stopped, closeAttachment, broadcast, sendOutput, reconcileOutput, holdPendingPane, holdFor, heldRetry, retryFor, relookupFor });

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const member of attachment.clients) holdPending(member, paneId);
    attachments.delete(paneId);
    clearTimeout(attachment.retry);
    clearTimeout(attachment.relookup);
    clearTimeout(attachment.repaint);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) member.data.conversationInterests.delete(paneId);
    for (const member of attachment.clients) member.data.output.delete(paneId);
    releaseConversation(paneId);
    const retired = attachment.pty.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.pty.kill();
  }

  /** An interact client's terminal sizes the pty: the grid is remembered as this client's, and it drives. */
  function drivePty(paneId: string, client: Client, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    const claim = client.data.attached.get(paneId);
    if (claim) claim.keepSize = false;
    if (attachment && !attachment.mirror) {
      attachment.grids.delete(client);
      attachment.grids.set(client, { cols, rows });
      attachment.driver = client;
    }
    resizePty(paneId, cols, rows);
  }

  /**
   * herdr's attach stream is a diff against the screen it last sent: what a program drew once
   * (btop's boxes and titles) is gone from a tail that its later updates filled, and a client
   * joining with that tail alone never saw it. Told its window changed (SIGWINCH, the size kept),
   * `herdr terminal attach` sends the whole screen again; every client gets it, as any output.
   */
  function requestRepaint(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment || attachment.mirror || attachment.repaint) return;
    const cooldown = attachment.repaintedAt === undefined ? 0 : attachment.repaintedAt + REPAINT_MIN_INTERVAL_MS - Date.now();
    attachment.repaint = setTimeout(() => {
      attachment.repaint = undefined;
      if (attachments.get(paneId) !== attachment || !attachment.ready || attachment.held || attachment.mirror) return;
      attachment.repaintedAt = Date.now();
      (attachment.pty as PtySession).winch();
    }, Math.max(REPAINT_COALESCE_MS, cooldown));
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    // a mirrored pane's grid is herdr's own: no browser resizes it
    if (!attachment || attachment.mirror || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.pty.resize(cols, rows);
    // herdr redraws the whole screen for a new size: a repaint still waiting would send it twice
    clearTimeout(attachment.repaint);
    attachment.repaint = undefined;
    attachment.repaintedAt = Date.now();
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  function detach(paneId: string, client: Client): void {
    holdPending(client, paneId);
    client.data.conversationInterests.delete(paneId);
    client.data.output.delete(paneId);
    releaseConversation(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    attachment.grids.delete(client);
    if (attachment.driver === client) attachment.driver = undefined;
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /** An ending connection leaves its panes while its claims still count, then drops them (dropClaims). */
  function detachClaimed(client: Client): void {
    for (const paneId of client.data.attached.keys()) detach(paneId, client);
  }

  function dropClaims(client: Client): void {
    client.data.attached.clear();
    client.data.conversationInterests.clear();
    client.data.output.clear();
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  return { attachments, pendingAttachments, conversations, releaseConversation, reconcileOutput, sendOutput, closeAttachment, drivePty, requestRepaint, ensureAttachment, detach, detachClaimed, dropClaims, releaseUnclaimed };
}
