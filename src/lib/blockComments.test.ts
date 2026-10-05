import { describe, expect, it } from "bun:test";
import { parseMarkdown, type ListBlock, type MarkdownBlock } from "./markdown.ts";
import { BLOCK_COMMENTS_PREFIX, BlockCommentStore, blockContent, blockTarget, commentTarget, isMarkdownBlock, outgoingMessage, quoteFor, replyPart, type BlockComment, type CommentTarget } from "./blockComments.ts";

const TS = "2026-10-03T10:12:00Z";
const TIME = Date.parse(TS);
const reply = replyPart("o", TS, 7, 0);
/** the first block `source` parses to */
const first = (source: string): MarkdownBlock => parseMarkdown(source)[0]!;
/** a comment as the store keeps it */
const stored = (id: string, note: string, target: CommentTarget): BlockComment => ({ id, comment: note, anchor: target.anchor, block: target.block, order: [target.turnTime!, ...target.position] });
/** a stored comment `note` on the block `text` parses to, at `path` in `reply` */
const comment = (id: string, path: number[], text: string, note: string): BlockComment => stored(id, note, blockTarget(reply, path, first(text)));

describe("replyPart", () => {
  it("anchors a turn by its timestamp and orders it by its time", () => {
    expect(replyPart("o", TS, 7, 1)).toEqual({ owner: "o", turnKey: TS, part: 1, turnTime: TIME });
  });
  it("anchors a turn without a timestamp by its index, and leaves its time open", () => {
    expect(replyPart("o", null, 7, 0)).toEqual({ owner: "o", turnKey: "7", part: 0, turnTime: null });
  });
  it("leaves the time open for a timestamp it cannot read", () => {
    expect(replyPart("o", "yesterday", 7, 0).turnTime).toBeNull();
  });
});

describe("blockTarget", () => {
  it("anchors a block by turn, part and path and places it by part and path", () => {
    const paragraph = first("Hello");
    expect(blockTarget(reply, [2], paragraph)).toEqual({ anchor: `${TS}:0:2`, turnTime: TIME, position: [0, 2], block: paragraph });
  });

  it("stores a list item as a one-item list that keeps its number but not its nested blocks", () => {
    const list = first("3. x\n4. y\n   - z") as ListBlock;
    const target = blockTarget(reply, [0, 1], list, 1);
    expect(target.anchor.endsWith(":0.1")).toBe(true);
    expect(target.position).toEqual([0, 0, 1]);
    expect(target.block).toEqual({ type: "list", ordered: true, start: 4, items: [{ content: list.items[1]!.content }] });
  });

  it("gives an unordered list item no start", () => {
    const list = first("- a\n- b") as ListBlock;
    expect(blockTarget(reply, [0, 0], list, 0).block).toEqual({ type: "list", ordered: false, items: [{ content: list.items[0]!.content }] });
  });
});

describe("blockContent", () => {
  it("joins a paragraph's lines and drops inline markup", () => {
    expect(blockContent(first("a **b** [c](https://x)\nd"))).toBe("a b c\nd");
  });
  it("reads a heading with inline code", () => {
    expect(blockContent(first("## Title `code`"))).toBe("Title code");
  });
  it("reads a code block's source", () => {
    expect(blockContent(first("```ts\nconst a = 1;\n```"))).toBe("const a = 1;");
  });
  it("reads a table row by row", () => {
    expect(blockContent(first("| a | b |\n|---|---|\n| 1 | 2 |"))).toBe("a | b\n1 | 2");
  });
  it("reads a blockquote's blocks", () => {
    expect(blockContent(first("> one\n>\n> two"))).toBe("one\ntwo");
  });
  it("reads nothing from a rule", () => {
    expect(blockContent({ type: "hr" })).toBe("");
  });
});

describe("quoteFor", () => {
  it("collapses whitespace", () => {
    expect(quoteFor("  a\n\n b  ")).toBe("a b");
  });
  it("keeps 80 characters and cuts 81 to 79 plus an ellipsis", () => {
    expect(quoteFor("x".repeat(80))).toBe("x".repeat(80));
    const cut = quoteFor("x".repeat(81));
    expect(cut).toBe(`${"x".repeat(79)}…`);
    expect(cut.length).toBe(80);
  });
  it("never cuts an emoji in half", () => {
    const cut = quoteFor(`${"x".repeat(79)}😀😀`);
    expect(cut.endsWith("…")).toBe(true);
    // a lone surrogate: a high one not followed by a low one, or a low one not preceded by a high one
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
  });
});

describe("outgoingMessage", () => {
  const a = comment("a", [0], "first", "c1");
  const b = comment("b", [1], "second", "c2");

  it("sends typed text alone when there are no comments", () => {
    expect(outgoingMessage([], "hi")).toEqual({ message: "hi", sentIds: [], commentsHeld: null, tooLong: false, sendable: true });
  });
  it("puts comments first, in reading order, then the typed text", () => {
    const out = outgoingMessage([b, a], "text");
    expect(out.message).toBe("> first\nc1\n\n> second\nc2\n\ntext");
    expect(out.sentIds).toEqual(["a", "b"]);
  });
  it("sends comments alone when the typed text is only whitespace", () => {
    const out = outgoingMessage([a], "   ");
    expect(out.message).toBe("> first\nc1");
    expect(out.sendable).toBe(true);
  });
  it("has nothing to send without comments and text", () => {
    expect(outgoingMessage([], "  ").sendable).toBe(false);
  });
  it("keeps comments out of a slash command", () => {
    expect(outgoingMessage([a], "/compact")).toEqual({ message: "/compact", sentIds: [], commentsHeld: "command", tooLong: false, sendable: true });
    expect(outgoingMessage([a], "  /compact").commentsHeld).toBe("command");
  });
  it("sends comments with text that only starts with a path, which is no command", () => {
    expect(outgoingMessage([a], "/Users/me/x.ts fails").commentsHeld).toBe(null);
    expect(outgoingMessage([a], "/tmp is full").commentsHeld).toBe("command");
    expect(outgoingMessage([a], "/skill:review now").commentsHeld).toBe("command");
  });
  it("keeps comments out of an answer to an open question, so the answer stays an answer", () => {
    expect(outgoingMessage([a], "1", { answering: true })).toEqual({ message: "1", sentIds: [], commentsHeld: "answer", tooLong: false, sendable: true });
    expect(outgoingMessage([a], "", { answering: true }).sendable).toBe(false);
  });
  it("keeps comments out of a pane without an agent: the text is typed into a shell, which would run the quote", () => {
    // "> first" is a redirect to a shell: it empties the file named "first" and runs the comment as a command
    expect(outgoingMessage([a], "ls", { agent: false })).toEqual({ message: "ls", sentIds: [], commentsHeld: "no-agent", tooLong: false, sendable: true });
    expect(outgoingMessage([a], "", { agent: false }).sendable).toBe(false);
    expect(outgoingMessage([a], "1", { answering: true, agent: false }).commentsHeld).toBe("no-agent");
    expect(outgoingMessage([], "ls", { agent: false }).commentsHeld).toBe(null);
  });
  it("refuses a message over the composer limit", () => {
    const long = { ...a, comment: "x".repeat(20_000) };
    const out = outgoingMessage([long], "");
    expect(out.tooLong).toBe(true);
    expect(out.sendable).toBe(false);
  });
});

describe("isMarkdownBlock", () => {
  it("accepts every parsed block type", () => {
    const source = "\\[\nx\n\\]\n\n# h\n\np\n\n- l\n\n> q\n\n```\nc\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---";
    const blocks = parseMarkdown(source);
    expect(new Set(blocks.map((block) => block.type))).toEqual(new Set(["math", "heading", "paragraph", "list", "blockquote", "code", "table", "hr"]));
    for (const block of blocks) expect(isMarkdownBlock(block)).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isMarkdownBlock({ type: "video" })).toBe(false);
    expect(isMarkdownBlock(null)).toBe(false);
    expect(isMarkdownBlock("x")).toBe(false);
  });
});

/** a store on an in-memory storage, with the map behind it to inspect */
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, storage, store: new BlockCommentStore(() => storage) };
}
const KEY = `${BLOCK_COMMENTS_PREFIX}o`;
/** the target for the block `text` parses to, at `path` in `reply` */
const at = (path: number[], text: string) => blockTarget(reply, path, first(text));

describe("BlockCommentStore", () => {
  it("keeps one comment per anchor: a second save edits it", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "one");
    store.save("o", at([0], "first"), "two");
    expect(store.list("o").map((c) => c.comment)).toEqual(["two"]);
  });

  it("removes a comment saved blank, and the storage key with the last one", () => {
    const { store, data } = fixture();
    store.save("o", at([0], "first"), "one");
    expect(data.has(KEY)).toBe(true);
    store.save("o", at([0], "first"), "  ");
    expect(store.list("o")).toEqual([]);
    expect(data.has(KEY)).toBe(false);
  });

  it("does nothing for a blank save without a comment", () => {
    const { store } = fixture();
    let updates = 0;
    store.subscribe(() => { updates++; });
    store.save("o", at([0], "first"), "");
    expect(updates).toBe(0);
  });

  it("keeps the identity of everything a save did not change", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "one");
    store.save("p", at([0], "first"), "other pane");
    const before = store.get("o", at([0], "first"));
    const otherPane = store.list("p");
    expect(store.list("o")).toBe(store.list("o"));
    store.save("o", at([1], "second"), "two");
    expect(store.get("o", at([0], "first"))).toBe(before);
    expect(store.list("p")).toBe(otherPane);
  });

  it("lists comments in reading order, whatever order they were saved in", () => {
    const { store } = fixture();
    store.save("o", at([3], "later"), "b");
    store.save("o", at([1], "earlier"), "a");
    expect(store.list("o").map((c) => c.comment)).toEqual(["a", "b"]);
  });

  it("removes only the given comments, so one saved during a send survives it", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "sent");
    const sentIds = store.list("o").map((c) => c.id);
    store.save("o", at([1], "second"), "added while sending");
    store.remove("o", sentIds);
    expect(store.list("o").map((c) => c.comment)).toEqual(["added while sending"]);
  });

  it("keeps a comment edited while a send was on its way: the send carried the old text", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "old");
    const sentIds = store.list("o").map((c) => c.id);
    store.save("o", at([0], "first"), "edited while sending");
    store.remove("o", sentIds);
    expect(store.list("o").map((c) => c.comment)).toEqual(["edited while sending"]);
  });

  it("keeps a comment whose block changed under its anchor when another block is commented there", () => {
    const { store } = fixture();
    store.save("o", at([0], "the old reply"), "about old");
    store.save("o", at([0], "a new reply"), "about new");
    expect(store.list("o").map((c) => c.comment).sort()).toEqual(["about new", "about old"]);
    expect(store.get("o", at([0], "a new reply"))?.comment).toBe("about new");
  });

  it("does not delete a comment whose block changed when the block now at its anchor is saved blank", () => {
    const { store } = fixture();
    store.save("o", at([0], "the old reply"), "about old");
    store.save("o", at([0], "a new reply"), "");
    expect(store.list("o").map((c) => c.comment)).toEqual(["about old"]);
  });

  it("reads back what it wrote, tables and list items included", () => {
    const { store, storage } = fixture();
    store.save("o", at([0], "| a | b |\n|---|---|\n| 1 | 2 |"), "table");
    store.save("o", blockTarget(reply, [1, 1], first("3. x\n4. y"), 1), "item");
    expect(new BlockCommentStore(() => storage).list("o")).toEqual(store.list("o"));
  });

  it("drops what it cannot read and keeps the rest", () => {
    const { data, storage } = fixture();
    data.set(KEY, "{");
    expect(new BlockCommentStore(() => storage).list("o")).toEqual([]);
    const good = stored("g", "kept", at([0], "first"));
    const video = { ...good, id: "v", anchor: "x:0:1", block: { type: "video" } };
    const broken = { ...good, id: "b", anchor: "x:0:2", block: { type: "list", ordered: false, items: [{}] } };
    data.set(KEY, JSON.stringify({ version: 1, comments: [video, good, broken] }));
    expect(new BlockCommentStore(() => storage).list("o")).toEqual([good]);
  });

  it("keeps a comment in memory when storage refuses it", () => {
    const store = new BlockCommentStore(() => ({ getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} }));
    store.save("o", at([0], "first"), "one");
    expect(store.list("o").map((c) => c.comment)).toEqual(["one"]);
    expect(store.isUnsaved("o")).toBe(true);
  });

  it("refreshes from storage another tab wrote, and only then notifies", () => {
    const { store, data } = fixture();
    store.save("o", at([0], "first"), "one");
    let updates = 0;
    store.subscribe(() => { updates++; });
    store.refresh("o");
    expect(updates).toBe(0);
    data.set(KEY, JSON.stringify({ version: 1, comments: [stored("t", "from the other tab", at([0], "first"))] }));
    store.refresh("o");
    expect(updates).toBe(1);
    expect(store.list("o").map((c) => c.comment)).toEqual(["from the other tab"]);
  });
});

describe("commentTarget", () => {
  it("edits a stored comment in place, where its block is not rendered", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "one");
    store.save("o", commentTarget(store.list("o")[0]!), "two");
    expect(store.list("o").map((c) => [c.comment, c.order])).toEqual([["two", [TIME, 0, 0]]]);
  });
});

describe("BlockCommentStore.get", () => {
  it("hands out a comment only for the block it was written on: the reply may have changed under its anchor", () => {
    const { store } = fixture();
    store.save("o", at([0], "first"), "c");
    expect(store.get("o", at([0], "first"))?.comment).toBe("c");
    expect(store.get("o", at([0], "a reply that changed"))).toBeUndefined();
  });
});

describe("reading order without a turn time", () => {
  const untimed = (path: number[], text: string) => blockTarget(replyPart("o", null, 3, 0), path, first(text));

  it("places a comment on a turn without a time by when it was written, in the same unit as a turn's time", () => {
    let now = TIME + 60_000;
    const { storage } = fixture();
    const store = new BlockCommentStore(() => storage, () => now);
    store.save("o", untimed([0], "untimed"), "written after the timed turn");
    store.save("o", at([5], "timed"), "on the timed turn");
    expect(store.list("o").map((c) => c.comment)).toEqual(["on the timed turn", "written after the timed turn"]);
    now = 1;
    store.save("o", untimed([0], "untimed"), "edited");
    expect(store.list("o").map((c) => c.comment)).toEqual(["on the timed turn", "edited"]);
  });

  it("keeps such a comment across a reload", () => {
    const { store, storage } = fixture();
    store.save("o", untimed([0], "untimed"), "kept");
    expect(new BlockCommentStore(() => storage).list("o").map((c) => c.comment)).toEqual(["kept"]);
  });
});
