import { expect, it } from "bun:test";
import { HerdrError } from "./herdr/client.ts";
import { MirrorSession, mirrorFrame, mirrorRows } from "./mirror.ts";

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
    // every screen whole unless a test asks for rows
    wholeMs: 0,
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

it("draws only the rows that changed, each cleared in its place with line wrap off", () => {
  expect(mirrorRows("a\r\nb\r\nc", "a\r\nB\r\nc", 24)).toBe("\x1b[?25l\x1b[?7l\x1b[2;1H\x1b[0m\x1b[2KB\x1b[0m\x1b[?7h");
  // a row that is gone is cleared, one that is new is drawn; trailing newlines are no rows
  expect(mirrorRows("a\nb\nc\n", "a\n", 24)).toBe("\x1b[?25l\x1b[?7l\x1b[2;1H\x1b[0m\x1b[2K\x1b[3;1H\x1b[0m\x1b[2K\x1b[0m\x1b[?7h");
  // a read longer than the grid: the rows on the screen are its last ones, counted from the top of the grid
  expect(mirrorRows("1\n2\n3\n4", "1\n2\n3\nX", 2)).toBe("\x1b[?25l\x1b[?7l\x1b[2;1H\x1b[0m\x1b[2KX\x1b[0m\x1b[?7h");
  expect(mirrorRows("1\n2\n3", "1\n2\n3\n4", 2)).toBe("\x1b[?25l\x1b[?7l\x1b[1;1H\x1b[0m\x1b[2K3\x1b[2;1H\x1b[0m\x1b[2K4\x1b[0m\x1b[?7h");
  expect(mirrorRows("a", "a\nb", 24)).toBe("\x1b[?25l\x1b[?7l\x1b[2;1H\x1b[0m\x1b[2Kb\x1b[0m\x1b[?7h");
});

it("sends the whole screen first and after a while, and the changed rows in between", async () => {
  let now = 1_000_000;
  const clock = Date.now;
  Date.now = () => now;
  try {
    const { session, read, frames } = pane({ wholeMs: 10_000 });
    const screen = (spinner: string) => ["first row of the screen", "second row of the screen", `working ${spinner}`, "last row of the screen"].join("\r\n");
    (await read(1)).resolve(screen("|"));
    (await read(2)).resolve(screen("/"));
    await read(3);
    now += 10_000;
    (await read(3)).resolve(screen("-"));
    await read(4);
    expect(frames).toEqual([mirrorFrame(screen("|")), mirrorRows(screen("|"), screen("/"), 24), mirrorFrame(screen("-"))]);
    expect(frames[1]).toBe("\x1b[?25l\x1b[?7l\x1b[3;1H\x1b[0m\x1b[2Kworking /\x1b[0m\x1b[?7h");
    // a client joining late gets the screen whole, whatever went out last
    expect(session.current).toBe(mirrorFrame(screen("-")));
    session.kill();
  } finally { Date.now = clock; }
});

it("sends the whole screen when the changed rows would be longer, as when output scrolls", async () => {
  const { session, read, frames } = pane({ wholeMs: 60_000 });
  const before = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\r\n");
  const scrolled = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\r\n");
  (await read(1)).resolve(before);
  (await read(2)).resolve(scrolled);
  (await read(3)).resolve(scrolled.replace("line 24", "line 24!"));
  await read(4);
  expect(frames).toEqual([mirrorFrame(before), mirrorFrame(scrolled), mirrorRows(scrolled, scrolled.replace("line 24", "line 24!"), 24)]);
  session.kill();
});

it("reads the screen at once after something was typed, instead of waiting out an idle screen", async () => {
  const { session, read, asked, frames } = pane({ idleMs: 60_000, activeMs: 60_000, echoMs: 0 });
  (await read(1)).resolve("$ ");
  // the next read is a minute away
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(1);
  session.write("l");
  (await read(2)).resolve("$ l");
  // typed again while that read was on its way: one more read follows it, not a second loop
  session.write("s");
  session.poke();
  (await read(3)).resolve("$ ls");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(3);
  expect(frames).toEqual([mirrorFrame("$ "), mirrorFrame("$ l"), mirrorFrame("$ ls")]);
  session.kill();
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
