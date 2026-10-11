import { expect, test } from "bun:test";
import { createMermaidQueue, mermaidInputAllowed, type MermaidImage } from "./mermaidRender.ts";

test("plain Korean flowcharts and sequence diagrams are allowed, with bounded original input", () => {
  expect(mermaidInputAllowed("flowchart LR\nA[시작] --> B[완료]")).toBe(true);
  expect(mermaidInputAllowed("%% explanation\nsequenceDiagram\nAlice->>Bob: hello")).toBe(true);
  for (const source of ["", "flowchart LR\n" + "x".repeat(20_000), "architecture-beta\nservice a(server)[A]"]) expect(mermaidInputAllowed(source)).toBe(false);
});

test("configuration, active HTML, CSS and resource syntax are refused before rendering", () => {
  for (const source of [
    '---\nconfig:\n securityLevel: loose\n---\nflowchart LR\nA-->B',
    'flowchart LR\n%%{init: {"securityLevel":"loose"}}%%\nA-->B',
    'flowchart LR\nA[<img src="/api/probe" onerror="alert(1)">]',
    'flowchart LR\nA-->B; click A href "https://example.com"',
    'flowchart LR\nA-->B\nclassDef red fill:red; color:red',
    'flowchart LR\nA-->B\nstyle A fill:url(https://example.com/x)',
    'flowchart LR\nA-->B\nlinkStyle 0 stroke:red',
    'flowchart LR\nA@{ img: "https://example.com/x" }',
    'flowchart LR\nA[fa:fa-home]',
    'flowchart LR\nA["`![x](/probe)`"]',
    'flowchart LR\nA["&lt;img src=/probe&gt;"]',
  ]) expect(mermaidInputAllowed(source)).toBe(false);
});

const image = (source: string): MermaidImage => ({ svg: `<svg>${source}</svg>`, width: 100, height: 80 });
const chart = (name: string) => `flowchart LR\n${name}-->End`;

test("identical pending work is shared and configuration/render jobs stay serial", async () => {
  let running = 0;
  let maximum = 0;
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queue = createMermaidQueue(async (source) => {
    running++; maximum = Math.max(maximum, running); calls.push(source);
    await gate;
    running--;
    return image(source);
  });
  const first = queue.render(chart("A"), "dark");
  expect(queue.render(chart("A"), "dark")).toBe(first);
  const second = queue.render(chart("B"), "light");
  release();
  await Promise.all([first, second]);
  expect(maximum).toBe(1);
  expect(calls).toEqual([chart("A"), chart("B")]);
  await queue.render(chart("A"), "dark");
  expect(calls.length).toBe(2);
  await queue.render(chart("A"), "light");
  expect(calls.length).toBe(3);
});

test("queue saturation and rejected source do not call the renderer; failure releases capacity", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const queue = createMermaidQueue(async (source) => { calls.push(source); await gate; throw new Error("parse failed"); }, { pending: 1 });
  const first = queue.render(chart("A"), "dark");
  await expect(queue.render(chart("B"), "dark")).rejects.toThrow("busy");
  await expect(queue.render("flowchart LR\nA[<img src=x>]", "dark")).rejects.toThrow("unsupported");
  release();
  await expect(first).rejects.toThrow("parse failed");
  await expect(queue.render(chart("B"), "dark")).rejects.toThrow("parse failed");
  expect(calls).toEqual([chart("A"), chart("B")]);
});

test("LRU and UTF-8 byte budgets evict old images without retaining rejected results", async () => {
  const calls: string[] = [];
  const queue = createMermaidQueue(async (source) => { calls.push(source); return image(source); }, { entries: 2, bytes: 1_000 });
  await queue.render(chart("A"), "dark");
  await queue.render(chart("B"), "dark");
  await queue.render(chart("A"), "dark");
  await queue.render(chart("C"), "dark");
  await queue.render(chart("B"), "dark");
  expect(calls).toEqual([chart("A"), chart("B"), chart("C"), chart("B")]);
  let count = 0;
  const limited = createMermaidQueue(async () => { count++; return image("한글".repeat(10)); }, { bytes: 40 });
  await limited.render(chart("A"), "dark");
  await limited.render(chart("A"), "dark");
  expect(count).toBe(2);
});
