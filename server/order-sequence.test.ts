import { expect, spyOn, test } from "bun:test";
import { OrderSequence } from "./order-sequence.ts";

test("a read takes the number of moves confirmed when it starts, and a move takes the next", () => {
  const order = new OrderSequence("boot-1");
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 0 });
  expect(order.moved()).toEqual({ order_epoch: "boot-1", moved_seq: 1 });
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 1 });
  expect(order.read()).toEqual({ order_epoch: "boot-1", read_seq: 1 });
  expect(order.moved()).toEqual({ order_epoch: "boot-1", moved_seq: 2 });
});

test("a pre-move read delivered after confirmation stays fenced", () => {
  const order = new OrderSequence("boot-1");
  const now = spyOn(Date, "now").mockReturnValue(5_000);
  const monotonic = spyOn(performance, "now").mockReturnValue(5_000);
  try {
    const before = order.read();
    const receipt = order.moved();
    // delivered later at a frozen, then a backward clock: the numbers are what they were
    now.mockReturnValue(1_000);
    monotonic.mockReturnValue(1_000);
    expect(before.read_seq < receipt.moved_seq).toBe(true);
    expect(order.read().read_seq >= receipt.moved_seq).toBe(true);
    expect(now).not.toHaveBeenCalled();
    expect(monotonic).not.toHaveBeenCalled();
  } finally { now.mockRestore(); monotonic.mockRestore(); }
});

test("a server lifetime is its own epoch: another starts again at 0", () => {
  const first = new OrderSequence("boot-1");
  first.moved(); first.moved();
  const next = new OrderSequence("boot-2");
  expect(next.read()).toEqual({ order_epoch: "boot-2", read_seq: 0 });
  expect(next.moved()).toEqual({ order_epoch: "boot-2", moved_seq: 1 });
});
