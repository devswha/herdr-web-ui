import { expect, it } from "bun:test";
import { AttachOutputTail, AttachStartupProbes } from "./attach-output.ts";

const teardown = "\x1b[?1049l\x1b[?25h\x1b[0 q";
const diagnostic = "herdr: server shut down: terminal attach taken over\r\n";

it("drops only the confirmed trailing diagnostic across every read boundary, keeping terminal modes", () => {
  const output = "pane output" + teardown + diagnostic;
  for (let cut = 1; cut < output.length; cut++) {
    const tail = new AttachOutputTail();
    expect(tail.push(output.slice(0, cut)) + tail.push(output.slice(cut)) + tail.flush(true)).toBe("pane output" + teardown);
  }
  const tail = new AttachOutputTail();
  expect([...output].map((byte) => tail.push(byte)).join("") + tail.flush(true)).toBe("pane output" + teardown);
});

it("preserves ordinary pane output, incomplete diagnostics and diagnostics without a takeover exit", () => {
  for (const output of [diagnostic, teardown + diagnostic + "more output", teardown + "herdr: another error", teardown + diagnostic, teardown + diagnostic + "\n".repeat(1000)]) {
    const tail = new AttachOutputTail();
    expect(tail.push(output) + tail.flush()).toBe(output);
  }
  const tail = new AttachOutputTail();
  expect(tail.push(teardown + "herdr: server shut down: term") + tail.flush(true)).toBe(teardown + "herdr: server shut down: term");
});

it("answers herdr's startup probes and keeps them out of the output across every read boundary", () => {
  const input = "\x1b[?1049h\x1b[?1016$p\x1b[cpane\x1b[?1049l";
  for (let cut = 1; cut < input.length; cut++) {
    const probes = new AttachStartupProbes();
    const first = probes.take(input.slice(0, cut));
    const second = probes.take(input.slice(cut));
    expect(first.output + second.output + probes.flush()).toBe("\x1b[?1049hpane\x1b[?1049l");
    expect(first.replies + second.replies).toBe("\x1b[?1016;0$y\x1b[?1;2c");
  }
});

it("passes other sequences through, and returns a held start that never became a probe", () => {
  const probes = new AttachStartupProbes();
  expect(probes.take("\x1b[?1004h\x1b[0c")).toEqual({ output: "\x1b[?1004h\x1b[0c", replies: "" });
  expect(probes.take("text\x1b[?10")).toEqual({ output: "text", replies: "" });
  expect(probes.flush() + probes.flush()).toBe("\x1b[?10");
});
