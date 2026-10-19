/**
 * Messages a connection sends to wait for the agent: queued for its next turn, or held for the
 * sender's Send now. Each carries a lease on the pane's terminal and on the sender's authority,
 * checked again before every write, so a message is typed only into the attach it was sent from
 * while that connection may still type. A turn's end sends the pane's next message; losing the
 * lease holds it for the sender to review instead of sending it.
 */
import { closeMention, freeClaudeBox, freeHermesInput, pendingFault, pendingIdentity } from "./composer.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import type { TerminalSighting } from "./terminals.ts";
import type { HerdrPane, PendingMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { typingGuards } from "../input-guard.ts";
import { claudeForegroundSession } from "../claude-store.ts";
import { HerdrError, paneProcessInfo, paneRead, paneSendKeys, paneSendText } from "../herdr/client.ts";
import { claudeHeldIsGrey, codexQuestionsCollapsed, isClaudeHeld, heldCandidate, modelListWaits, noteSubmitted, parseInteractivePrompt } from "../prompt.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { PendingInputs, samePendingIdentity, type PendingIdentity, type PendingRecord } from "../pending-input.ts";
import { processStartedAt } from "../process-start.ts";
import { PendingRequestBook } from "../pending-requests.ts";
import { interruptCodexSteering } from "../codex-steering.ts";
import type { OmoStatus } from "../omo-status.ts";

type PendingLease = { sighting: TerminalSighting; authority: object };
type PendingItem = PendingRecord<Client, PendingLease>;
export type SubmitReply = { ok: boolean; pending?: PendingMessage; code?: string; message?: string };

/**
 * The server's pending messages. `authorizeSocket`, `clientSnapshot` and `omo` belong to the
 * connections and the status hub, which are built after this (they take its store), so they are
 * called through: only a frame or a turn calls them, after `createServer` has returned.
 */
export function createPendingDelivery({ options, clients, sight, serialize, lastTyped, authorizeSocket, clientSnapshot, omo, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS }: {
  options: { pendingStartTimeoutMs?: number; submitDeadlineMs?: number; submitDelayMs?: number };
  clients: Set<Client>;
  sight: (client: Client, paneId: string) => TerminalSighting;
  serialize: <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;
  lastTyped: ReadonlyMap<string, number>;
  authorizeSocket: (client: Client) => void;
  clientSnapshot: () => Promise<SessionSnapshot>;
  omo: Pick<OmoStatus, "sessionOf">;
  SUBMIT_DEADLINE_MS: number;
  SUBMIT_DELAY_MS: number;
  TYPED_SETTLE_MS: number;
}) {
  const pendingAuthorities = new WeakMap<Client, Map<string, object>>();
  const pending = new PendingInputs<Client, PendingLease>((owner, paneId, messages, removed) => {
    send(owner, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
  }, Date.now, options.pendingStartTimeoutMs);
  const pendingDrains = new Set<string>();
  const pendingRequests = new WeakMap<Client, PendingRequestBook<SubmitReply>>();
  // the last input_draft refusal per pane: its named draft (Clear it and send), or none (Send anyway)
  const draftConfirmations = new WeakMap<Client, Map<string, { draft: string | null; identity: PendingIdentity; box?: string | null }>>();

  function pendingLease(owner: Client, paneId: string): PendingLease {
    const sighting = sight(owner, paneId);
    if (!sighting.facts().attached) throw new HerdrError("input_not_ready", "The pane is not attached and ready");
    let authorities = pendingAuthorities.get(owner);
    if (!authorities) { authorities = new Map(); pendingAuthorities.set(owner, authorities); }
    let authority = authorities.get(paneId);
    if (!authority) { authority = {}; authorities.set(paneId, authority); }
    const lease = { sighting, authority };
    authorizePending(owner, paneId, lease);
    return lease;
  }
  // Losing authority cancels already-running checks too. Rejoining the same shared
  // attachment or returning to interact must never revive a captured lease.
  function holdPending(owner: Client, paneId?: string): void {
    if (paneId === undefined) pendingAuthorities.delete(owner);
    else pendingAuthorities.get(owner)?.delete(paneId);
    pending.hold(owner, paneId);
  }
  function holdPendingPane(paneId: string, fault: { code: string; message: string }): void {
    for (const owner of clients) pendingAuthorities.get(owner)?.delete(paneId);
    pending.holdPane(paneId, fault);
  }
  function authorizePending(owner: Client, paneId: string, lease: PendingLease): void {
    authorizeSocket(owner);
    if (!clients.has(owner) || connectionOf(owner).closing) throw new HerdrError("disconnected", "The pending message's connection closed");
    if (pendingAuthorities.get(owner)?.get(paneId) !== lease.authority) throw new HerdrError("pending_lease_lost", "The pending message's authority changed; review it before sending again");
    const facts = lease.sighting.facts();
    if (facts.currentHeld) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
    if (!typingGuards.pendingLease(facts)) throw new HerdrError("input_not_ready", "The pending message's pane connection changed");
  }
  async function pendingContext(owner: Client, paneId: string, lease: PendingLease, identity?: PendingIdentity, pasted = false): Promise<{ pane: HerdrPane; identity: PendingIdentity; working: boolean; screen: string }> {
    authorizePending(owner, paneId, lease);
    // The same normalized snapshot the client sees includes a known Codex finish that
    // herdr reports as unknown. Nothing is inferred from a bare unknown state.
    const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const info = await paneProcessInfo(paneId);
    const pid = info?.foreground_processes?.[0]?.pid ?? null;
    const base = pendingIdentity(pane);
    const current: PendingIdentity = {
      ...base, processPid: pid, processBirth: pid === null ? null : processStartedAt(pid),
      omoSession: omo.sessionOf(paneId)?.sessionId ?? null,
      // Claude's own PID record says which session it runs, also without herdr's hook
      claudeSession: base.agent === "claude" ? await claudeForegroundSession(info?.foreground_processes ?? []) : null,
    };
    if (identity && !samePendingIdentity(identity, current)) {
      throw new HerdrError("pending_target_changed", "The pane's terminal or agent session changed; review the message before sending it again");
    }
    if (identity) {
      // Keep newly learned parts so a replacement before Enter is checked against them too.
      identity.session ??= current.session;
      identity.processPid ??= current.processPid;
      identity.processBirth ??= current.processBirth;
      identity.omoSession ??= current.omoSession;
      identity.claudeSession ??= current.claudeSession;
    }
    // the live screen, not the viewport: a pane scrolled into its history still draws its next
    // menu or password prompt at the bottom (server/prompt.ts liveScreen)
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, lease.sighting.facts().cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    const collapsed = current.agent === "codex" && codexQuestionsCollapsed(screen);
    // a message Claude Code holds for its invisible characters is a card to answer first, also once its hint has gone.
    // Not so with this delivery's own paste in the box (`pasted`), which the check before the paste found
    // free of a held message: the same words as the message noted before would be taken for that one,
    // and so would any paste under a hint left up from it (typing does not take Claude's hint down)
    const held = !pasted && current.agent === "claude" ? heldCandidate(paneId) : null;
    const prompt = current.agent ? parseInteractivePrompt(current.agent, screen, null, true, [], held) : null;
    // as the card's own reader decides it: Claude's grey text under a hint left behind is no held message
    const waits = prompt !== null && !(pasted && isClaudeHeld(prompt)) && !(await claudeHeldIsGrey(paneId, prompt));
    if (current.agent && (waits || modelListWaits(current.agent, screen) || (pane.agent_status === "blocked" && !collapsed))) {
      throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
    }
    if (current.agent && !["working", "idle", "done"].includes(pane.agent_status) && !collapsed) {
      throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
    }
    authorizePending(owner, paneId, lease);
    return { pane, identity: current, working: current.agent !== null && (pane.agent_status === "working" || collapsed), screen };
  }
  /**
   * The live screen for claudeInputDraft, and the viewport's colors when viewportShowsLive verifies
   * they show it. Read last, the live screen holds anything typed meanwhile. An empty box (or none)
   * needs no colors.
   */

  async function dispatchPendingText(owner: Client, paneId: string, text: string, lease: PendingLease, identity: PendingIdentity,
    automatic: boolean, arrivedAt: number, committing: (working: boolean, restarting?: boolean) => void = () => {}, interruptWorkingCodex = false): Promise<SubmitReply> {
    let wrote = false;
    // what the checks below read is older than a status event that arrives while they run
    let mark = pending.mark(paneId);
    try {
      const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
      // fixed wait: herdr holds a lone ESC typed into the pty ~150ms, so a Stop tapped just before reaches the pane first
      if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
      mark = pending.mark(paneId);
      const context = await pendingContext(owner, paneId, lease, identity);
      if (automatic && context.working) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      // a draft typed in the terminal is the user's: the paste would join it and the Enter send both (#609).
      // The box is the live screen's; only the viewport read tells Claude's grey text from a draft. The live
      // read comes after the colors, so text typed between the two is in the box and holds the message.
      if (context.identity.agent === "claude") await freeClaudeBox(paneId, context.working, () => authorizePending(owner, paneId, lease), arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS));
      else if (context.identity.agent === "hermes") await freeHermesInput(paneId, context.identity);
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      authorizePending(owner, paneId, lease);
      // asked again right before herdr is written to: its connect is awaited (#666)
      const allowed = (): boolean => {
        try { authorizePending(owner, paneId, lease); return true; } catch { return false; }
      };
      // Pending input is a guarded literal paste + Enter, never Codex's native Tab queue.
      // Keep the final key here so a disconnect, pane switch or new menu can cancel it.
      wrote = true;
      await paneSendText(paneId, `\u001b[200~${closeMention(text)}\u001b[201~`, undefined, allowed).catch((error: unknown) => {
        // a paste the guard refused was never written: the message is unsent, not uncertain
        if (error instanceof HerdrError && error.code === "cancelled") { wrote = false; authorizePending(owner, paneId, lease); }
        throw error;
      });
      // fixed wait: the TUI takes the paste before its Enter, which arriving with it could read as a newline
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      const beforeEnter = await pendingContext(owner, paneId, lease, identity, true);
      if (automatic && beforeEnter.working) throw new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed");
      authorizePending(owner, paneId, lease);
      const steering = !automatic && beforeEnter.working;
      committing(steering);
      // Claude Code queues what Enter commits during a turn; Ctrl+Enter sends it now (#737). herdr
      // encodes the key as the pane asked, and as a plain CR for a program that asked for nothing.
      await paneSendKeys(paneId, [steering && beforeEnter.identity.agent === "claude" ? "ctrl+enter" : "Enter"], undefined, allowed);
      // the status the panel was read under; a status event since (a finish, an approval) stales the Escape
      let statusAtRead = pending.current(paneId);
      await interruptCodexSteering(interruptWorkingCodex, closeMention(text), { agent: beforeEnter.identity.agent, working: beforeEnter.working, screen: beforeEnter.screen }, {
        read: async () => {
          const current = await pendingContext(owner, paneId, lease, identity, true);
          statusAtRead = pending.current(paneId);
          return { agent: current.identity.agent, working: current.working, screen: current.screen };
        },
        restarting: () => committing(true, true),
        // herdr has no compare-and-send: the screen can change between this read and the write, so the
        // write is refused when the lease, the deadline or the pane's status moved meanwhile
        escape: (fresh) => paneSendKeys(paneId, ["Escape"], undefined, () => allowed() && fresh() && pending.current(paneId) === statusAtRead),
      });
      noteSubmitted(paneId, text);
      return { ok: true };
    } catch (error) {
      const fault = wrote ? { code: "submit_changed", message: "Pending-message delivery could not be confirmed. Check the terminal before sending again." } : pendingFault(error);
      if (automatic && !wrote && fault.code === "agent_blocked") pending.observe(paneId, "blocked", mark);
      return { ok: false, ...fault };
    }
  }
  async function dispatchPending(item: PendingItem, automatic: boolean, arrivedAt: number, interruptWorkingCodex = false): Promise<SubmitReply> {
    const reply = await dispatchPendingText(item.owner, item.paneId, item.message.text, item.lease, item.identity,
      automatic, arrivedAt, (working, restarting) => pending.committing(item, working, restarting), interruptWorkingCodex);
    pending.settle(item, reply.ok ? undefined : { code: reply.code!, message: reply.message! }, reply.code === "submit_changed",
      automatic && ["pending_wait", "agent_blocked"].includes(reply.code ?? ""));
    return reply;
  }
  function drainPending(paneId: string): void {
    if (pendingDrains.has(paneId) || pending.next(paneId) === null) return;
    pendingDrains.add(paneId);
    const arrivedAt = Date.now();
    void serialize(paneId, async () => {
      const item = pending.next(paneId);
      if (item && pending.claim(item, true)) await dispatchPending(item, true, arrivedAt);
    }).catch((error) => console.warn("pending message:", pendingFault(error).code)).finally(() => {
      pendingDrains.delete(paneId);
      drainPending(paneId);
    });
  }
  function replayPendingOutcome(owner: Client, paneId: string, id: string): boolean {
    const outcome = pending.outcome(owner, paneId, id);
    if (!outcome) return false;
    send(owner, { type: "pending-messages", pane_id: paneId, messages: pending.list(owner, paneId), removed: [{ id, outcome }] });
    return true;
  }

  return { pending, holdPending, holdPendingPane, drainPending, pendingLease, pendingContext, dispatchPendingText, dispatchPending, replayPendingOutcome, pendingRequests, draftConfirmations };
}
