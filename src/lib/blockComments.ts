import { createContext, useSyncExternalStore } from "react";
import { isSlashCommand, MAX_COMPOSER_CHARS } from "./compose.ts";
import type { InlineNode, ListBlock, MarkdownBlock } from "./markdown.ts";

/**
 * Comments on single blocks of an agent's final reply. This module owns what a comment is: how a
 * block is anchored, where it sits in reading order, which form of it is kept, and how the
 * comments travel in the next message. The chat and the composer only consume it.
 */

/** Where a rendered reply part sits: made by `replyPart`, read only by this module. */
export interface ReplyPart {
  /** `paneStorageId(machineId, paneId)`: comments belong to one pane */
  owner: string;
  /** the turn's timestamp, or its index in the transcript when it has none */
  turnKey: string;
  /** index of the final-answer part within the turn */
  part: number;
  /** the turn's time in ms; null when it has none, or none that reads as a time */
  turnTime: number | null;
}

/**
 * The reply part `part` of the turn at `index` with timestamp `ts`. A turn without a timestamp
 * (a transcript entry without a time) is anchored by its index, which
 * can later name another block: `save` keeps the earlier comment apart instead of overwriting it.
 */
export function replyPart(owner: string, ts: string | null, index: number, part: number): ReplyPart {
  const time = ts === null ? Number.NaN : Date.parse(ts);
  return { owner, turnKey: ts ?? String(index), part, turnTime: Number.isFinite(time) ? time : null };
}

/** A block that can carry a comment. */
export interface CommentTarget {
  /**
   * `${turnKey}:${part}:${path}`, e.g. "2026-10-03T10:12:00Z:0:3.1". A stored comment whose block
   * was replaced under it carries `${anchor}~${id}` instead (see `save`).
   */
  anchor: string;
  /** the turn's time in ms, or null: a comment then takes the time it was written */
  turnTime: number | null;
  /** the reply part, then the path to the block in it */
  position: number[];
  /** the block as kept with the comment; a list item is a one-item list without nested blocks */
  block: MarkdownBlock;
}

export interface BlockComment {
  id: string;
  anchor: string;
  /**
   * Reading order, compared element by element, shorter first on a tie: the turn's time (or when
   * the comment was written, one unit for both), then `position`. The order comments are sent in.
   */
  order: number[];
  block: MarkdownBlock;
  comment: string;
}

/** Most characters a quoted block takes in the outgoing message, the trailing "…" included. */
export const QUOTE_MAX = 80;

/**
 * The target for a rendered block. `path` locates it inside the reply part (list items add their
 * index). With `item` given, `block` is a list and the target is that one item.
 */
export function blockTarget(reply: ReplyPart, path: number[], block: MarkdownBlock, item?: number): CommentTarget {
  return {
    anchor: `${reply.turnKey}:${reply.part}:${path.join(".")}`,
    turnTime: reply.turnTime,
    position: [reply.part, ...path],
    block: item === undefined ? block : itemBlock(block as ListBlock, item),
  };
}

/** The block a stored comment was written on, to edit it again where the block is not rendered. */
export function commentTarget(comment: BlockComment): CommentTarget {
  const [turnTime, ...position] = comment.order;
  return { anchor: comment.anchor, turnTime: turnTime ?? null, position, block: comment.block };
}

/** Item `index` of `list` as a one-item list: it keeps its number, not its nested blocks (they have their own targets). */
function itemBlock(list: ListBlock, index: number): ListBlock {
  const item = { content: list.items[index]!.content };
  return list.ordered
    ? { type: "list", ordered: true, start: (list.start ?? 1) + index, items: [item] }
    : { type: "list", ordered: false, items: [item] };
}

/** The text of inline nodes with their markup dropped: a link or emphasis reads as its words. */
function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => "value" in node ? node.value : inlineText(node.children)).join("");
}

/** The plain text of a block, without markup: what is quoted, and what tells two blocks apart. */
export function blockContent(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph": return block.lines.map(inlineText).join("\n");
    case "heading": return inlineText(block.content);
    case "list": return block.items.map((item) => inlineText(item.content)).join("\n");
    case "blockquote": return block.blocks.map(blockContent).filter((text) => text !== "").join("\n");
    case "code":
    case "math": return block.value;
    case "table": return [block.header, ...block.rows].map((row) => row.map(inlineText).join(" | ")).join("\n");
    case "hr": return "";
  }
}

/** One line of at most `max` characters, cut by code points so an emoji is never halved. */
export function quoteFor(content: string, max = QUOTE_MAX): string {
  const line = content.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

/** Compares two `BlockComment.order` values element by element; on a tie the shorter one comes first. */
function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** A copy of `comments` in reading order: the order they are listed and sent in. */
function sortComments(comments: readonly BlockComment[]): BlockComment[] {
  return [...comments].sort((a, b) => compareOrder(a.order, b.order));
}

/** Why comments stay in the composer instead of going with a message. */
export type CommentsHeldBy = "no-agent" | "answer" | "command";

/**
 * What the composer sends for `text` with these comments: each comment quotes its block, in
 * reading order, and the typed text follows. The comments wait for a later message when:
 * - no agent runs in the pane (`agent: false`): the text is typed into whatever does, a shell
 *   perhaps, which would run each line, take the quote's "> " for a redirect that empties a
 *   file, and expand `$(…)` in the quoted reply;
 * - it answers a question the agent has open (`answering`), read as an option or a reply;
 * - it is a slash command, which the agent would not read as one with comments in front.
 */
export function outgoingMessage(comments: readonly BlockComment[], text: string, { answering = false, agent = true }: { answering?: boolean; agent?: boolean } = {}): {
  message: string;
  /** the comments `message` carries: they leave the composer once the send is acknowledged */
  sentIds: string[];
  /** why comments that exist stay out of `message`; null when they go, or there are none */
  commentsHeld: CommentsHeldBy | null;
  tooLong: boolean;
  sendable: boolean;
} {
  const held: CommentsHeldBy | null = !agent ? "no-agent" : answering ? "answer" : isSlashCommand(text) ? "command" : null;
  const sent = held !== null ? [] : sortComments(comments);
  const entries = sent.map((c) => `> ${quoteFor(blockContent(c.block))}\n${c.comment.trim()}`);
  if (text.trim() !== "") entries.push(text);
  const message = entries.join("\n\n");
  const tooLong = message.length > MAX_COMPOSER_CHARS;
  return { message, sentIds: sent.map((c) => c.id), commentsHeld: comments.length > 0 ? held : null, tooLong, sendable: message.trim() !== "" && !tooLong };
}

// every block type markdown.ts knows: a new one fails to compile here rather than its comments
// vanishing on load
const BLOCK_TYPES: Record<string, true> = { math: true, heading: true, paragraph: true, list: true, blockquote: true, code: true, table: true, hr: true } satisfies Record<MarkdownBlock["type"], true>;

/** Has a known block `type`; whether the rest reads is `isStoredComment`'s question. */
export function isMarkdownBlock(value: unknown): value is MarkdownBlock {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && Object.hasOwn(BLOCK_TYPES, type);
}

export const BLOCK_COMMENTS_PREFIX = "herdr-web-ui:block-comments:";
type CommentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** A fresh comment id; a time-and-random fallback where `crypto.randomUUID` is missing (an insecure origin). */
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** An entry from storage that renders and quotes without throwing: hand-edited or older data is dropped. */
function isStoredComment(value: unknown): value is BlockComment {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<BlockComment>;
  if (typeof entry.id !== "string" || typeof entry.anchor !== "string" || typeof entry.comment !== "string") return false;
  if (!Array.isArray(entry.order) || !entry.order.every(Number.isFinite) || !isMarkdownBlock(entry.block)) return false;
  try { return typeof blockContent(entry.block) === "string"; } catch { return false; }
}

/**
 * Comments per pane (`owner`), kept in localStorage like the held-message queue. Snapshots keep
 * their identity until their own data changes, so `useSyncExternalStore` readers re-render only
 * for the comments they show.
 */
export class BlockCommentStore {
  private lists = new Map<string, readonly BlockComment[]>();
  /** the raw value last read or written, so `refresh` notices only real changes */
  private saved = new Map<string, string | null>();
  private unsaved = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private storage: () => CommentStorage = () => window.localStorage, private now: () => number = Date.now) {}

  /** For `useSyncExternalStore`: `listener` runs on every change to any pane's comments. Returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** True when the last write for `owner` failed: its comments live only in memory and are lost on reload. */
  isUnsaved(owner: string): boolean { return this.unsaved.has(owner); }

  /**
   * The pane's comments in reading order, read from storage on first use and cached after. Entries
   * that do not read as comments, and a second comment on an anchor, are dropped.
   */
  list(owner: string): readonly BlockComment[] {
    const cached = this.lists.get(owner);
    if (cached) return cached;
    let raw: string | null = null;
    try { raw = this.storage().getItem(BLOCK_COMMENTS_PREFIX + owner); } catch { /* private mode */ }
    let comments: BlockComment[] = [];
    try {
      const data = JSON.parse(raw ?? "null");
      if (data?.version === 1 && Array.isArray(data.comments)) {
        const anchors = new Set<string>();
        comments = data.comments.filter((entry: unknown): entry is BlockComment => {
          if (!isStoredComment(entry) || anchors.has(entry.anchor)) return false;
          anchors.add(entry.anchor);
          return true;
        });
      }
    } catch { /* unreadable: start empty */ }
    const sorted = sortComments(comments);
    this.saved.set(owner, raw);
    this.lists.set(owner, sorted);
    return sorted;
  }

  /** The comment on this very block: none when its anchor holds one on a block that was replaced. */
  get(owner: string, target: CommentTarget): BlockComment | undefined {
    const comment = this.list(owner).find((c) => c.anchor === target.anchor);
    return comment !== undefined && belongsTo(comment, target) ? comment : undefined;
  }

  /**
   * One comment per anchor; a blank comment removes it. A changed text gets a new id: a send on
   * its way carries the old text, and its acknowledgement must not take the edit with it. A
   * comment on another block that used to sit at this anchor is kept, moved off the anchor.
   */
  save(owner: string, target: CommentTarget, comment: string): void {
    this.refresh(owner);
    const text = comment.trim();
    let comments = this.list(owner);
    let existing = comments.find((c) => c.anchor === target.anchor);
    if (existing && !belongsTo(existing, target)) {
      const stale = existing;
      comments = comments.map((c) => c === stale ? { ...c, anchor: `${c.anchor}~${c.id}` } : c);
      existing = undefined;
    }
    if (text === "") {
      if (existing) this.write(owner, comments.filter((c) => c !== existing));
      else if (comments !== this.list(owner)) this.write(owner, comments);
      return;
    }
    if (existing?.comment === text) return;
    // an edit keeps its place: a turn without a time placed it by when it was first written
    const order = existing?.order ?? [target.turnTime ?? this.now(), ...target.position];
    const next: BlockComment = { id: newId(), anchor: target.anchor, order, block: target.block, comment: text };
    this.write(owner, existing ? comments.map((c) => c === existing ? next : c) : [...comments, next]);
  }

  /** Removes the comments with these ids, as a send acknowledges them; an id already gone is no change. */
  remove(owner: string, ids: readonly string[]): void {
    this.refresh(owner);
    const comments = this.list(owner);
    const kept = comments.filter((c) => !ids.includes(c.id));
    if (kept.length !== comments.length) this.write(owner, kept);
  }

  /** Re-read storage another tab may have written; notify only when it changed. */
  refresh(owner: string): void {
    if (this.unsaved.has(owner) || !this.lists.has(owner)) return;
    try {
      const raw = this.storage().getItem(BLOCK_COMMENTS_PREFIX + owner);
      if (raw === this.saved.get(owner)) return;
    } catch { return; }
    this.lists.delete(owner);
    this.list(owner);
    this.notify();
  }

  /** Caches and stores `owner`'s comments, the key removed with the last one; a failed write marks them unsaved. */
  private write(owner: string, comments: readonly BlockComment[]): void {
    this.lists.set(owner, sortComments(comments));
    try {
      const key = BLOCK_COMMENTS_PREFIX + owner;
      const raw = comments.length ? JSON.stringify({ version: 1, comments }) : null;
      if (raw === null) this.storage().removeItem(key);
      else this.storage().setItem(key, raw);
      this.saved.set(owner, raw);
      this.unsaved.delete(owner);
    } catch { this.unsaved.add(owner); }
    this.notify();
  }

  /** Tells every subscriber that some pane's comments changed. */
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** True when the stored comment belongs to this rendered block: the reply may have changed under its anchor. */
function belongsTo(comment: BlockComment, target: CommentTarget): boolean {
  return blockContent(comment.block) === blockContent(target.block);
}

export const blockComments = new BlockCommentStore();

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key?.startsWith(BLOCK_COMMENTS_PREFIX)) blockComments.refresh(event.key.slice(BLOCK_COMMENTS_PREFIX.length));
  });
}

const NONE: readonly BlockComment[] = [];

/**
 * The pane's comments in reading order, re-rendering when they change. The server snapshot is
 * empty: a reply rendered to a string (tests) shows no comments.
 */
export function useBlockComments(owner: string): readonly BlockComment[] {
  return useSyncExternalStore(blockComments.subscribe, () => blockComments.list(owner), () => NONE);
}

const noSubscription = () => () => {};

/** The comment on `target` (see `get`). No target: nothing to read and no subscription, for a block outside a commentable reply. */
export function useBlockComment(owner: string, target: CommentTarget | null): BlockComment | undefined {
  return useSyncExternalStore(target === null ? noSubscription : blockComments.subscribe, () => target === null ? undefined : blockComments.get(owner, target), () => undefined);
}

/** The reply part a `Markdown` renders; only a final answer that is not live provides one. */
export const BlockCommentContext = createContext<ReplyPart | null>(null);
