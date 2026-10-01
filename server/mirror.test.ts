import { expect, it } from "bun:test";
import { HerdrError } from "./herdr/client.ts";
import { MirrorSession, mirrorFrame } from "./mirror.ts";

/** A pane whose every read waits until the test answers it. */
function pane() {
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
    activeMs: 0,
    idleMs: 0,
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

it("paints the same screen again on request, for a grid that changed size", async () => {
  const { session, read, frames } = pane();
  (await read(1)).resolve("one");
  await read(2);
  session.repaint();
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("one")]);
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
