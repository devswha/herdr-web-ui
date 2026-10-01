import { expect, it } from "bun:test";
import { HerdrError } from "./herdr/client.ts";
import { MirrorSession, mirrorFrame } from "./mirror.ts";

/** A pane whose every read waits until the test answers it. */
function pane(extra: Partial<ConstructorParameters<typeof MirrorSession>[0]> = {}) {
  const asked: { resolve(screen: string): void; reject(error: unknown): void }[] = [];
  let wake: (() => void) | null = null;
  const frames: string[] = [];
  const exits: (number | null)[] = [];
  const written: string[] = [];
  const session = new MirrorSession({
    read: () => new Promise<string>((resolve, reject) => { asked.push({ resolve, reject }); wake?.(); }),
    write: async (data) => { written.push(data); },
    onData: (frame) => frames.push(frame),
    onExit: (code) => exits.push(code),
    cols: 80,
    rows: 24,
    activeMs: 0,
    idleMs: 0,
    ...extra,
  });
  /** the nth read, once the mirror asks for it */
  const read = async (n: number) => {
    while (asked.length < n) await Promise.race([
      new Promise<void>((resolve) => { wake = resolve; }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`read ${n} never asked`)), 2000)),
    ]);
    return asked[n - 1]!;
  };
  return { session, read, asked, frames, exits, written };
}

it("paints a screen as home, clear and rows, without a newline after the last row", () => {
  expect(mirrorFrame("a\nb\r\n\r\n")).toBe("\x1b[?25l\x1b[0m\x1b[H\x1b[2Ja\r\nb\x1b[0m");
});

it("sends a screen once, and again only when it changed", async () => {
  const { session, read, frames } = pane();
  (await read(1)).resolve("one");
  (await read(2)).resolve("one");
  (await read(3)).resolve("two");
  await read(4);
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("two")]);
  session.kill();
});

it("holds screens while paused and sends only the latest on resume", async () => {
  const { session, read, frames } = pane();
  (await read(1)).resolve("one");
  await read(2);
  session.pause();
  (await read(2)).resolve("two");
  (await read(3)).resolve("three");
  await read(4);
  expect(frames).toEqual([mirrorFrame("one")]);
  session.resume();
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("three")]);
  session.kill();
});

it("adopts the pane's new size, says so first, and paints the unchanged screen again", async () => {
  let size = { cols: 80, rows: 24 };
  const events: string[] = [];
  const { session, read, frames } = pane({ size: async () => size, sizeMs: 0, onResize: (cols, rows) => events.push(`resize ${cols}x${rows}`) });
  (await read(1)).resolve("one");
  await read(2);
  events.push(`frames ${frames.length}`);
  size = { cols: 100, rows: 30 };
  (await read(2)).resolve("one");
  (await read(3)).resolve("one");
  await read(4);
  events.push(`frames ${frames.length}`);
  expect(events).toEqual(["frames 1", "resize 100x30", "frames 2"]);
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("one")]);
  session.kill();
});

it("keeps the latest screen whole for a client joining late", async () => {
  const { session, read } = pane();
  expect(session.current).toBeNull();
  const big = Array.from({ length: 700 }, () => "x".repeat(400)).join("\r\n");
  (await read(1)).resolve(big);
  await read(2);
  expect(session.current).toBe(mirrorFrame(big));
  expect(Buffer.byteLength(session.current!)).toBeGreaterThan(256 * 1024);
  session.kill();
});

it("stops reading once killed, without calling it an exit", async () => {
  const { session, read, asked, frames, exits } = pane();
  const first = await read(1);
  session.kill();
  first.resolve("late");
  await session.exited;
  // the timer a live mirror would have set for its next read has had its turn
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(1);
  expect(frames).toEqual([]);
  expect(exits).toEqual([]);
});

it("ends as a terminal does when herdr says the pane is gone, and keeps trying a herdr that does not answer", async () => {
  const { session, read, exits } = pane();
  (await read(1)).reject(new HerdrError("connect_failed", "no herdr"));
  (await read(2)).reject(new HerdrError("pane_not_found", "pane gone"));
  await session.exited;
  expect(exits).toEqual([null]);
});

it("types into the pane through herdr", () => {
  const { session, written } = pane();
  session.write("ls\r");
  expect(written).toEqual(["ls\r"]);
  session.kill();
});
