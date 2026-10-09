import { expect, it } from "bun:test";
import { paneStorageId } from "../../shared/machines.ts";
import { assignViewNumbers, sessionStyle } from "./session-identity.ts";

const A = { machine_id: "local", pane_id: "same" };
const B = { machine_id: "remote", pane_id: "same" };
const C = { machine_id: "local", pane_id: "third" };

it("distinguishes identical pane IDs on different machines", () => {
  const numbers = assignViewNumbers(new Map(), [A, B]);
  expect(numbers.get(paneStorageId(A.machine_id, A.pane_id))).toBe(1);
  expect(numbers.get(paneStorageId(B.machine_id, B.pane_id))).toBe(2);
});

it("retains identities through reordering, removal, re-addition and new sessions", () => {
  const original = assignViewNumbers(new Map(), [A, B]);
  const reordered = assignViewNumbers(original, [B, A]);
  const removed = assignViewNumbers(reordered, [B]);
  const added = assignViewNumbers(removed, [C, B, A]);
  expect(reordered).toBe(original);
  expect(removed).toBe(original);
  expect([...added.values()]).toEqual([1, 2, 3]);
  expect(original.size).toBe(2);
});

it("deduplicates targets without consuming identity numbers", () => {
  const numbers = assignViewNumbers(new Map(), [A, A, B]);
  expect([...numbers.values()]).toEqual([1, 2]);
});

it("repeats color tokens but preserves unique numbers after eight views", () => {
  const targets = Array.from({ length: 12 }, (_, n) => ({ machine_id: "local", pane_id: String(n) }));
  const numbers = assignViewNumbers(new Map(), targets);
  expect(new Set(numbers.values()).size).toBe(12);
  expect(sessionStyle(9)).toEqual(sessionStyle(1));
  expect(sessionStyle(undefined)).toBeUndefined();
});
