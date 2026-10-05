import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { Check, Copy, MessageSquare, MessageSquarePlus } from "lucide-react";
import katex from "katex";

import "./BlockComments.css";

import { foldCode, parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from "../lib/markdown.ts";
import { codeIsFilePath, OpenFileContext, splitFilePaths } from "../lib/filePaths.ts";
import { fileUriPath } from "../lib/terminalFileLinks.ts";
import { useT } from "../lib/i18n.ts";
import { BlockCommentContext, blockComments, blockTarget, useBlockComment, type CommentTarget } from "../lib/blockComments.ts";
import { CommentEditor } from "./CommentEditor.tsx";

function MathExpression({ value, displayMode = false }: { value: string; displayMode?: boolean }) {
  try {
    // KaTeX escapes text and rejects untrusted commands by default.
    const html = katex.renderToString(value, { displayMode, strict: "ignore" });
    return <span className={displayMode ? "markdown-math-display" : "markdown-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span>{displayMode ? `\\[${value}\\]` : `\\(${value}\\)`}</span>;
  }
}

/** A file path the viewer opens: a button that reads as the text or code it replaced. */
function FilePath({ path, code, open }: { path: string; code: boolean; open: (path: string) => void }) {
  const t = useT();
  const label = code ? <code>{path}</code> : path;
  return <button type="button" className={`markdown-file${code ? " is-code" : ""}`} title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button>;
}

/** `interactive` is false inside a link or file label: nothing clickable nests in another. */
function Inline({ nodes, interactive = true }: { nodes: InlineNode[]; interactive?: boolean }) {
  const context = useContext(OpenFileContext);
  const open = interactive ? context : null;
  const t = useT();
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text":
        if (open === null) return <span key={key}>{node.value}</span>;
        return <span key={key}>{splitFilePaths(node.value).map((part, n) => typeof part === "string" ? part : <FilePath key={n} path={part.path} code={false} open={open} />)}</span>;
      case "code": {
        const file = fileUriPath(node.value);
        if (open !== null && file !== null) return <FilePath key={key} path={file} code open={open} />;
        // agents often put an address in backticks: it stays code to the eye, and opens
        if (interactive && /^https?:\/\/\S+$/i.test(node.value)) return <a key={key} className="markdown-code-link" href={node.value} target="_blank" rel="noopener noreferrer"><code>{node.value}</code></a>;
        return open !== null && codeIsFilePath(node.value) ? <FilePath key={key} path={node.value} code open={open} /> : <code key={key}>{node.value}</code>;
      }
      case "math": return <MathExpression key={key} value={node.value} />;
      case "strong": return <strong key={key}><Inline nodes={node.children} interactive={interactive} /></strong>;
      case "em": return <em key={key}><Inline nodes={node.children} interactive={interactive} /></em>;
      case "del": return <del key={key}><Inline nodes={node.children} interactive={interactive} /></del>;
      case "link": return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer"><Inline nodes={node.children} interactive={false} /></a>;
      // the label opens the file; where nothing can open one, the path shows after it, as Codex's terminal does
      case "file": {
        const label = <Inline nodes={node.children} interactive={false} />;
        return open !== null
          ? <button key={key} type="button" className="markdown-file" title={t("Open {path}", { path: node.path })} onClick={() => open(node.path)}>{label}</button>
          : <span key={key}>{label} (<code>{node.path}</code>)</span>;
      }
    }
  })}</>;
}

/** A list; each item is commentable on its own (`ItemView`), the list as a whole is not. */
function List({ block, path, commentable }: { block: ListBlock; path: number[]; commentable: boolean }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className="markdown-list" start={block.ordered ? block.start : undefined}>
      {block.items.map((_, index) => <ItemView key={index} list={block} index={index} path={[...path, index]} commentable={commentable} />)}
    </Tag>
  );
}

/** One list item: each one is a block of its own for comments, nested items included. */
function ItemView({ list, index, path, commentable }: { list: ListBlock; index: number; path: number[]; commentable: boolean }) {
  const item = list.items[index]!;
  const comment = useCommentable(path, list, commentable, index);
  return (
    <li className={comment.className} onClick={comment.onClick}>
      {comment.add}
      <Inline nodes={item.content} />
      {comment.after}
      {item.blocks !== undefined && <Blocks blocks={item.blocks} path={path} commentable={commentable} />}
    </li>
  );
}

function CodeBlock({ language, value }: { language: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const block = useRef<HTMLDivElement>(null);
  // no inner scroll: a long block folds, with a visible "Show all" row
  const fold = useMemo(() => foldCode(value), [value]);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const folding = useRef(false);
  const toggle = (): void => {
    folding.current = expanded;
    setExpanded(!expanded);
  };
  // "Show less" sits at the bottom of a long block: after folding, bring the block's top back
  // into view rather than leave the reader far below it
  useLayoutEffect(() => {
    if (!folding.current) return;
    folding.current = false;
    const node = block.current;
    const view = node?.closest(".chat-view");
    if (node && view && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
  }, [expanded]);
  return (
    <div className="markdown-code" ref={block}>
      <div className="markdown-code-header">
        <span>{language || "text"}</span>
        <button type="button" className="icon-button markdown-code-copy" onClick={() => void copy()} aria-label={t(copied ? "Code copied" : "Copy code")}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      <pre><code>{fold !== null && !expanded ? fold.head : value}</code></pre>
      {fold !== null && (
        <button type="button" className="markdown-code-more" aria-expanded={expanded} onClick={toggle}>
          {expanded ? t("Show less") : t("Show all {n} lines", { n: fold.lines })}
        </button>
      )}
    </div>
  );
}

const NO_PATH: number[] = [];

/**
 * `path` locates the blocks inside the reply part (a list item's index is part of it), which is
 * how a comment finds its block again. Inside a blockquote nothing is commentable on its own:
 * the quote is one block.
 */
function Blocks({ blocks, path = NO_PATH, commentable = true }: { blocks: MarkdownBlock[]; path?: number[]; commentable?: boolean }) {
  return <>{blocks.map((block, index) => <BlockView key={`${block.type}-${index}`} block={block} path={[...path, index]} commentable={commentable} />)}</>;
}

/**
 * One block at `path`, with its "+" and comment row where it is commentable. A rule carries no
 * comment, and a list carries them on its items.
 */
function BlockView({ block, path, commentable }: { block: MarkdownBlock; path: number[]; commentable: boolean }): ReactNode {
  const comment = useCommentable(path, block, commentable && block.type !== "hr" && block.type !== "list");
  const { className, onClick } = comment;
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <><Tag className={className} onClick={onClick}>{comment.add}<Inline nodes={block.content} /></Tag>{comment.after}</>;
    }
    case "paragraph":
      return <><p className={className} onClick={onClick}>{comment.add}{block.lines.map((line, lineIndex) => <span key={lineIndex}><Inline nodes={line} />{lineIndex < block.lines.length - 1 && <br />}</span>)}</p>{comment.after}</>;
    case "list": return <List block={block} path={path} commentable={commentable} />;
    case "blockquote": return <><blockquote className={className} onClick={onClick}>{comment.add}<Blocks blocks={block.blocks} path={path} commentable={false} /></blockquote>{comment.after}</>;
    case "hr": return <hr />;
    default: {
      const body = block.type === "code" ? <CodeBlock language={block.language} value={block.value} />
        : block.type === "math" ? <MathExpression value={block.value} displayMode />
        : <div className="markdown-table-wrap">
          <table><thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}><Inline nodes={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>;
      // a code block clips and a table scrolls its own box: the "+" and the bar sit on a host around
      // it. The host is there whether or not the block is commentable, so a reply turning final (or
      // live again) keeps the same element, and a code block the reader unfolded stays unfolded
      return <><div className={className === undefined ? "markdown-block" : `markdown-block ${className}`} onClick={onClick}>{comment.add}{body}</div>{comment.after}</>;
    }
  }
}

/** The block a tap chose on a touch screen: it shows its "+". One at a time, across every reply. */
let selectedAnchor: string | null = null;
const selectionListeners = new Set<() => void>();
const noSubscription = () => () => {};

/** Chooses the block at `anchor` (null: none) and listens for a press outside it while one is chosen. */
function selectBlock(anchor: string | null): void {
  if (selectedAnchor === anchor) return;
  selectedAnchor = anchor;
  if (anchor === null) document.removeEventListener("pointerdown", clearOutside, true);
  else document.addEventListener("pointerdown", clearOutside, true);
  for (const listener of selectionListeners) listener();
}

/** A press anywhere but on the chosen block lets it go; a press on another block then chooses that one. */
function clearOutside(event: PointerEvent): void {
  if (!(event.target instanceof Element) || event.target.closest(".is-commentable.is-selected") === null) selectBlock(null);
}

/** For `useSyncExternalStore`: `listener` runs whenever the chosen block changes. Returns the unsubscribe. */
function subscribeSelection(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => { selectionListeners.delete(listener); };
}

/** A boolean snapshot: a new choice re-renders only the block that lost it and the one that got it. */
function useIsSelected(anchor: string | null): boolean {
  return useSyncExternalStore(anchor === null ? noSubscription : subscribeSelection, () => anchor !== null && selectedAnchor === anchor, () => false);
}

interface Commentable {
  /** undefined where the block is not commentable */
  className: string | undefined;
  onClick: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  /** the "+", inside the block's element */
  add: ReactNode;
  /** the comment row and the editor, right after the block's content */
  after: ReactNode;
}

/** The comment being written: kept as it was opened, so it outlives the block turning uncommentable. */
interface Editing {
  owner: string;
  target: CommentTarget;
  initialComment: string;
}

/**
 * What makes a block commentable; nothing where it is not (outside a final answer, inside a
 * blockquote, a rule) except an editor still open on it. With `item`, `block` is the list and the
 * target its item `item`.
 */
function useCommentable(path: number[], block: MarkdownBlock, enabled: boolean, item?: number): Commentable {
  const t = useT();
  const reply = useContext(BlockCommentContext);
  const key = path.join(".");
  // `path` is a new array on every render; `key` is its value
  const target = useMemo(() => enabled && reply !== null ? blockTarget(reply, path, block, item) : null, [enabled, reply, key, block, item]);
  const commented = useBlockComment(reply?.owner ?? "", target);
  const selected = useIsSelected(target?.anchor ?? null);
  // the agent may start again while a comment is written, and the reply turn live: the editor and
  // what is typed in it stay until it is saved or closed
  const [editing, setEditing] = useState<Editing | null>(null);
  const editor = editing !== null && <CommentEditor
    block={editing.target.block}
    initialComment={editing.initialComment}
    onSave={(comment) => { blockComments.save(editing.owner, editing.target, comment); setEditing(null); }}
    onClose={() => setEditing(null)}
  />;
  // the same tree either way, so the editor keeps its state when the block stops being commentable
  const after = (row: ReactNode): ReactNode => <>{row}{editor}</>;
  if (target === null || reply === null) return { className: undefined, onClick: undefined, add: null, after: after(null) };
  const open = (): void => setEditing({ owner: reply.owner, target, initialComment: commented?.comment ?? "" });
  return {
    className: `is-commentable${commented ? " is-commented" : ""}${selected ? " is-selected" : ""}`,
    onClick: (event) => {
      // the editor is portalled but its clicks bubble here through React, and a nested item's click
      // bubbles to its parent item: only a click on this very block counts
      if (!(event.target instanceof Element) || event.target.closest(".is-commentable") !== event.currentTarget) return;
      if (!window.matchMedia("(hover: none)").matches) return;
      if (event.target.closest("a, button, summary, input, textarea") !== null) return;
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      selectBlock(target.anchor);
    },
    add: <button type="button" className="block-comment-add" aria-label={t("Comment on this part")} title={t("Comment on this part")} onClick={open}><MessageSquarePlus aria-hidden="true" /></button>,
    after: after(commented && <button type="button" className="block-comment-row" data-comment-id={commented.id} title={t("Edit comment")} onClick={open}><MessageSquare aria-hidden="true" /><span>{commented.comment}</span></button>),
  };
}

/** Blocks already parsed, as the chat shows them: a comment's block in the comment editor. */
export function MarkdownBlocks({ blocks }: { blocks: MarkdownBlock[] }) {
  // the editor is portalled out of a reply but inherits its context: no "+" inside the editor
  return <BlockCommentContext.Provider value={null}><div className="markdown"><Blocks blocks={blocks} /></div></BlockCommentContext.Provider>;
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(children), [children]);
  return <div className={className === undefined ? "markdown" : `markdown ${className}`}><Blocks blocks={blocks} /></div>;
}
