import type { PlanStep } from "../../shared/protocol.ts";
import { toolVerbKind, type ToolVerbKind } from "./toolVerbs.ts";

/**
 * A plan's steps by wave: a step comes one wave after the last of the steps it waits on, so a
 * wave's steps can run side by side. Order inside a wave is the plan's own. A wait that loops
 * back is not followed.
 */
export function planWaves(steps: readonly PlanStep[]): PlanStep[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (step: PlanStep): number => {
    const known = level.get(step.id);
    if (known !== undefined) return known;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    let wave = 0;
    for (const id of step.blocked_by) {
      const before = byId.get(id);
      if (before !== undefined) wave = Math.max(wave, depth(before) + 1);
    }
    visiting.delete(step.id);
    level.set(step.id, wave);
    return wave;
  };
  const waves: PlanStep[][] = [];
  for (const step of steps) (waves[depth(step)] ??= []).push(step);
  return waves.filter((wave) => wave !== undefined);
}

/**
 * Where the plan stands, in the words a person would use: the steps running now, the ones that
 * can start now (nothing they wait on is unfinished), and the ones still waiting on others.
 */
export function planOutlook(steps: readonly PlanStep[]): { running: PlanStep[]; ready: PlanStep[]; waiting: PlanStep[] } {
  const running = steps.filter((step) => step.status === "in_progress");
  const pending = steps.filter((step) => step.status === "pending");
  return { running, ready: pending.filter((step) => unfinishedBefore(step, steps).length === 0), waiting: pending.filter((step) => unfinishedBefore(step, steps).length > 0) };
}

/** The steps `step` waits on that are not done yet (a wait on a step that is gone is no wait). */
export function unfinishedBefore(step: PlanStep, steps: readonly PlanStep[]): PlanStep[] {
  return step.blocked_by.flatMap((id) => steps.find((other) => other.id === id && other.status !== "completed") ?? []);
}

/** The steps that wait on `step`: what it lets go once it is done. */
export function stepsAfter(step: PlanStep, steps: readonly PlanStep[]): PlanStep[] {
  return steps.filter((other) => other.blocked_by.includes(step.id));
}

/**
 * The other steps whose run overlapped this one's (from its start to its end, or `now` while it
 * runs): a call made while several ran is counted in each of them.
 */
export function ranAlongside(step: PlanStep, steps: readonly PlanStep[], now: number): PlanStep[] {
  const span = (of: PlanStep): [number, number] | null => {
    const start = of.started_at === null ? NaN : Date.parse(of.started_at);
    const end = of.ended_at === null ? (of.status === "in_progress" ? now : NaN) : Date.parse(of.ended_at);
    return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
  };
  const mine = span(step);
  if (mine === null) return [];
  return steps.filter((other) => {
    if (other === step) return false;
    const theirs = span(other);
    return theirs !== null && theirs[0] < mine[1] && mine[0] < theirs[1];
  });
}

export type ActivityKind = ToolVerbKind | "search" | "agent";
const SEARCH = new Set(["grep", "glob", "websearch", "webfetch", "toolsearch"]);
const AGENT = new Set(["agent", "task", "spawn_agent"]);

/** What kind of work a tool call is, for words a person reads; null for a tool known only by its name. */
export function activityKind(tool: string): ActivityKind | null {
  const key = tool.toLowerCase();
  return toolVerbKind(tool) ?? (SEARCH.has(key) ? "search" : AGENT.has(key) ? "agent" : null);
}

/** A step's calls by kind, the most first, each tool no kind takes kept by its own name. */
export function activityTally(tools: readonly { name: string; count: number }[]): { kind: ActivityKind | null; name: string; count: number }[] {
  const tally = new Map<string, { kind: ActivityKind | null; name: string; count: number }>();
  for (const tool of tools) {
    const kind = activityKind(tool.name);
    const key = kind ?? `tool:${tool.name}`;
    const known = tally.get(key) ?? { kind, name: tool.name, count: 0 };
    known.count += tool.count;
    tally.set(key, known);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}

export const FLOW = { nodeWidth: 156, nodeHeight: 58, columnGap: 16, rowGap: 34, pad: 6 } as const;

export interface FlowLayout {
  width: number;
  height: number;
  nodes: { step: PlanStep; x: number; y: number }[];
  /** `done`: the step it comes from is done, so the way on is open */
  edges: { from: string; to: string; path: string; done: boolean }[];
}

/**
 * Where each step's box goes (waves top to bottom, each wave centred, a wave wider than
 * `maxColumns` wrapped onto more rows) and the curve from each step it waits on.
 */
export function flowLayout(steps: readonly PlanStep[], maxColumns = 4): FlowLayout {
  const { nodeWidth, nodeHeight, columnGap, rowGap, pad } = FLOW;
  const waves = planWaves(steps).flatMap((wave) => Array.from({ length: Math.ceil(wave.length / maxColumns) }, (_, row) => wave.slice(row * maxColumns, (row + 1) * maxColumns)));
  const columns = Math.max(1, ...waves.map((wave) => wave.length));
  const width = pad * 2 + columns * nodeWidth + (columns - 1) * columnGap;
  const height = pad * 2 + waves.length * nodeHeight + Math.max(0, waves.length - 1) * rowGap;
  const nodes = waves.flatMap((wave, row) => {
    const left = (width - (wave.length * nodeWidth + (wave.length - 1) * columnGap)) / 2;
    return wave.map((step, column) => ({ step, x: left + column * (nodeWidth + columnGap), y: pad + row * (nodeHeight + rowGap) }));
  });
  const at = new Map(nodes.map((node) => [node.step.id, node]));
  const edges = nodes.flatMap(({ step, x, y }) => step.blocked_by.flatMap((id) => {
    const from = at.get(id);
    if (from === undefined || from.y >= y) return [];
    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight;
    const x2 = x + nodeWidth / 2;
    const bend = Math.max(rowGap * 0.6, (y - y1) / 2);
    return [{ from: id, to: step.id, path: `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y - bend}, ${x2} ${y}`, done: from.step.status === "completed" }];
  }));
  return { width, height, nodes, edges };
}
