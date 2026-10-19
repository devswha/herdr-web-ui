import { expect, it } from "bun:test";
import { conversationFinishPresented, paneCovered, PANE_COVER_SELECTOR } from "./panePresentation.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";

for (const source of ["claude-transcript", "codex-transcript"] as const) {
  it(`${source} requires the newest answer's native final marker, not an earlier complete turn`, () => {
    const done: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] };
    const user: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Next request" }] };
    const partial: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Still working", phase: "commentary" }] };
    expect(conversationFinishPresented({ source, turns: [done] })).toBe(true);
    for (const turns of [[], [done, user], [done, user, partial],
      [{ ...partial, parts: [{ kind: "text" as const, text: "Unlabelled prose" }] }],
      [{ ...done, parts: [...done.parts, { kind: "thinking" as const, text: "More work" }] }]]) {
      expect(conversationFinishPresented({ source, turns })).toBe(false);
    }
  });
}

it("does not replace transcript-derived native status with a hook-agent completion rule", () => {
  expect(conversationFinishPresented({ source: "gjc-transcript", turns: [
    { role: "assistant", ts: null, parts: [{ kind: "text", text: "Native stop" }] },
  ] })).toBe(true);
});

/** Exercise the production selector with Bun's CSS selector engine, not a string assertion. */
async function covered(html: string): Promise<boolean> {
  let matched = false;
  await new HTMLRewriter().on(PANE_COVER_SELECTOR, { element() { matched = true; } })
    .transform(new Response(html)).text();
  return matched;
}

it("treats a composer's slash or file listbox popup as covering the pane", async () => {
  expect(await covered('<div class="menu composer-menu"><div role="listbox"><button role="option">Option</button></div></div>')).toBe(true);
});

it("treats the failed-suggestions popup as coverage even without a listbox role", async () => {
  expect(await covered('<div class="menu composer-menu"><div class="composer-menu-group"><p class="chat-inline-error">Failed</p></div></div>')).toBe(true);
});

it("leaves a docked file panel and a plain inline listbox uncovered", async () => {
  expect(await covered('<aside class="file-panel"><section class="file-viewer file-viewer-docked"></section></aside><div role="listbox"></div>')).toBe(false);
});

it("ignores retained hidden covers without ignoring another presented dialog", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const nodes = [
    { closest: () => ({}), getClientRects: () => [{}], visibility: "visible" },
    { closest: () => null, getClientRects: () => [], visibility: "visible" },
    { closest: () => null, getClientRects: () => [{}], visibility: "hidden" },
  ];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => nodes } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (node: { visibility: string }) => node });
  try {
    expect(paneCovered()).toBe(false);
    nodes.push({ closest: () => null, getClientRects: () => [{}], visibility: "visible" });
    expect(paneCovered()).toBe(true);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
    if (beforeStyle) Object.defineProperty(globalThis, "getComputedStyle", beforeStyle);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
