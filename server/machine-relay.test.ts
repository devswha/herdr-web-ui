import { describe, expect, it } from "bun:test";
import { RelayStall } from "./machine-relay.ts";
import { OUTPUT_STALL_MS } from "./output-window.ts";

describe("remote PC relay stall clock", () => {
  it("keeps a connection whose queue is draining, however long it stays non-empty", () => {
    const stall = new RelayStall();
    stall.queue(200 * 1024);
    // a phone on a weak link takes a large replay in a few seconds: the queue shrinks every tick
    let buffered = 200 * 1024;
    for (let at = 0; at <= 2500; at += 100) {
      expect(stall.tick(buffered, at)).toBe(false);
      buffered -= 3 * 1024;
    }
  });

  it("counts a browser ACK that moves as progress, and a duplicate as none", () => {
    const stall = new RelayStall();
    stall.queue(120 * 1024);
    expect(stall.tick(120 * 1024, 0)).toBe(false);
    // the queue is stuck at the socket, but the browser keeps parsing what already arrived
    for (let at = 500; at <= 2500; at += 500) {
      stall.ack("p1", "s1", at, at);
      expect(stall.tick(120 * 1024, at)).toBe(false);
    }
    stall.ack("p1", "s1", 2500, 3000);
    expect(stall.tick(120 * 1024, 2500 + OUTPUT_STALL_MS)).toBe(false);
    expect(stall.tick(120 * 1024, 2501 + OUTPUT_STALL_MS)).toBe(true);
  });

  it("stalls a queue that holds bytes without progress for OUTPUT_STALL_MS", () => {
    const stall = new RelayStall();
    stall.queue(4096);
    expect(stall.tick(4096, 0)).toBe(false);
    expect(stall.tick(4096, OUTPUT_STALL_MS)).toBe(false);
    expect(stall.tick(4096, OUTPUT_STALL_MS + 1)).toBe(true);
    // an emptied queue starts over
    const fresh = new RelayStall();
    fresh.queue(4096);
    expect(fresh.tick(4096, 0)).toBe(false);
    expect(fresh.tick(0, 1000)).toBe(false);
    fresh.queue(4096);
    expect(fresh.tick(4096, 1100)).toBe(false);
    expect(fresh.tick(4096, 1100 + OUTPUT_STALL_MS + 1)).toBe(true);
  });

  it("does not take new bytes on a stuck queue for progress", () => {
    const stall = new RelayStall();
    stall.queue(4096);
    expect(stall.tick(4096, 0)).toBe(false);
    stall.queue(1024);
    expect(stall.tick(5120, 1000)).toBe(false);
    expect(stall.tick(5120, OUTPUT_STALL_MS + 1)).toBe(true);
  });
});
