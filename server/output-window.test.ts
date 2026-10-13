import { describe, expect, it } from "bun:test";
import { OutputWindow, OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_JOIN_MAX_MS, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS, ReplayBuffer } from "./output-window.ts";

describe("terminal output credit", () => {
  it("holds high-water backpressure until the low watermark, without duplicate credit", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES - 1);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.blocked).toBe(false);
    const pending = window.pending;
    window.acknowledge(window.id, 0);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.pending).toBe(pending);
  });

  it("rejects stale subscriptions, impossible offsets and non-integer credit", () => {
    const old = new OutputWindow();
    const current = new OutputWindow();
    current.write(100);
    expect(current.acknowledge(old.id, 100)).toBe(false);
    for (const value of [-1, 101, 0.5, NaN, Infinity]) expect(current.acknowledge(current.id, value)).toBe(false);
    expect(current.pending).toBe(100);
    expect(current.acknowledge(current.id, 100)).toBe(true);
    expect(current.pending).toBe(0);
  });

  it("closes a blocked client only after OUTPUT_STALL_MS without ACK progress", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 0)).toBe("pause");
    expect(window.check(0, OUTPUT_STALL_MS - 1)).toBe("pause");
    expect(window.check(0, OUTPUT_STALL_MS)).toBe("stop");
  });

  it("restarts the stall clock on every ACK that moves, never on a duplicate", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES * 2);
    expect(window.check(0, 0)).toBe("pause");
    // still far above the low watermark, but the client is draining
    expect(window.acknowledge(window.id, 64 * 1024)).toBe(true);
    expect(window.blocked).toBe(true);
    expect(window.check(0, 1500)).toBe("pause");
    expect(window.check(0, 3000)).toBe("pause");
    // the same credit again is no progress
    window.acknowledge(window.id, 64 * 1024);
    expect(window.check(0, 3499)).toBe("pause");
    expect(window.check(0, 1500 + OUTPUT_STALL_MS)).toBe("stop");
  });

  it("lets a joiner on a slow link acknowledge a large replay after 3 s (moshi-3)", () => {
    const window = new OutputWindow();
    const replay = 200 * 1024;
    window.join(replay, 0);
    window.write(replay);
    window.write(OUTPUT_HIGH_BYTES - replay); // live output on top of it blocks the window
    expect(window.blocked).toBe(true);
    for (const at of [0, OUTPUT_STALL_MS, 3000]) expect(window.check(0, at)).toBe("flow");
    expect(window.acknowledge(window.id, replay)).toBe(true);
    expect(window.joinUntil).toBeUndefined();
    expect(window.blocked).toBe(false);
    expect(window.check(0, 3000)).toBe("flow");
    // from here it is an ordinary client again
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 3100)).toBe("pause");
    expect(window.check(0, 3100 + OUTPUT_STALL_MS)).toBe("stop");
  });

  it("never pauses the shared pty for a joiner, and bounds the time it gets", () => {
    const window = new OutputWindow();
    window.join(OUTPUT_HARD_BYTES, 0);
    window.write(OUTPUT_HIGH_BYTES + 1024);
    // the transport queue counts as blocked too
    expect(window.check(OUTPUT_HIGH_BYTES, 1000)).toBe("flow");
    expect(window.joinUntil).toBe(OUTPUT_JOIN_MAX_MS);
    expect(window.check(0, OUTPUT_JOIN_MAX_MS - 1)).toBe("flow");
    expect(window.check(0, OUTPUT_JOIN_MAX_MS)).toBe("stop");
    // a full transport queue stops it at once
    const full = new OutputWindow();
    full.join(1024, 0);
    expect(full.check(OUTPUT_HARD_BYTES, 0)).toBe("stop");
  });

  it("gives a joiner whose small replay is acknowledged nothing beyond the usual deadline", () => {
    const window = new OutputWindow();
    window.join(1024, 0);
    window.write(1024);
    window.acknowledge(window.id, 1024);
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 10_000)).toBe("pause");
    expect(window.check(0, 10_000 + OUTPUT_STALL_MS)).toBe("stop");
    // and one that never acknowledged anything is out of budget soon after its replay
    const silent = new OutputWindow();
    silent.join(1024, 0);
    silent.write(1024 + OUTPUT_HIGH_BYTES);
    expect(silent.check(0, OUTPUT_STALL_MS + 32)).toBe("stop");
  });

  it("bounds replay in bytes without corrupting Korean or emoji at the cut", () => {
    const text = "시작🙂끝";
    for (let limit = 1; limit <= Buffer.byteLength(text); limit++) {
      const replay = new ReplayBuffer(limit);
      replay.append("prefix");
      replay.append(text);
      const tail = replay.text();
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(limit);
      expect(tail).not.toContain("�");
      expect(text.endsWith(tail)).toBe(true);
    }
  });

  it("leads a late joiner's replay with the modes that fell out of the tail", () => {
    const replay = new ReplayBuffer(16);
    replay.append("\x1b[?1006l\x1b[?1016l\x1b[?1000l\x1b[?1049h\x1b[?1000h\x1b[?1002;1006h\x1b[?25l");
    replay.append("x".repeat(40));
    // each at its last state, in the order of those last switches: 1006h after 1016l
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l" + "x".repeat(16));
    // a switch the cut would split is kept whole in the tail, not lost to both halves
    replay.append("\x1b[?1049l" + "y".repeat(16));
    replay.append("y".repeat(16));
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[?1049l" + "y".repeat(16));
  });

  it("passes a modifyOtherKeys request that fell out of the tail on to a late joiner", () => {
    const replay = new ReplayBuffer(16);
    replay.append("\x1b[?1049h\x1b[>4;2m");
    replay.append("x".repeat(40));
    expect(replay.text()).toBe("\x1b[?1049h\x1b[>4;2m" + "x".repeat(16));
    // other key modifier resources are not it
    replay.append("\x1b[>1;2m\x1b[>41m\x1b[>0m" + "y".repeat(40));
    expect(replay.text()).toBe("\x1b[?1049h\x1b[>4;2m" + "y".repeat(16));
    // herdr turns it off as CSI > 4 ; 0 m; a program may also write CSI > 4 m or CSI > 4 n
    // and a bare CSI > m or CSI > n resets every resource; CSI > 0 m is another resource
    for (const off of ["\x1b[>4;0m", "\x1b[>4m", "\x1b[>4n", "\x1b[>m", "\x1b[>n"]) {
      replay.append("\x1b[>4;1m" + off + "z".repeat(40));
      expect(replay.text()).toBe("\x1b[?1049h" + "z".repeat(16));
    }
    // a request the cut would split stays whole in the tail
    replay.append("\x1b[>4;2m" + "w".repeat(10));
    expect(replay.text()).toBe("\x1b[?1049h" + "\x1b[>4;2m" + "w".repeat(10));
  });

  it("replays a short stream as it is, and nothing before any output", () => {
    const replay = new ReplayBuffer(1024);
    expect(replay.text()).toBe("");
    replay.append("\x1b[?1049h\x1b[?1000hhello");
    expect(replay.text()).toBe("\x1b[?1049h\x1b[?1000hhello");
  });
});
