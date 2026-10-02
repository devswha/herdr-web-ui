/**
 * A terminal for a herdr that cannot `terminal attach` (Windows, herdrdev/herdr#4821).
 * There is no byte stream to forward, so the pane's visible screen is read a few times a
 * second (`pane.read`, ansi) and each changed screen goes out in the same `pty-data` frames a
 * real attach sends: the rows that changed, each drawn in its place, and the whole screen at
 * the start, after a resize and every few seconds. A working agent changes a spinner and a
 * timer on almost every read (measured with gjc on a 119x40 pane: 12 screens a second, 2.8
 * rows changed in each), so whole screens were 135 KB a second to every viewer, over SSH from
 * a remote PC and on to a phone; the changed rows are 9 KB a second (#261). Output that scrolls
 * changes every row, and then the whole screen is the shorter of the two and goes out instead. It stands where a PtySession stands, so
 * the attach lifecycle, the replay for late joiners and the output window are the same.
 *
 * What a repaint cannot give: herdr's read carries no cursor position (the cursor is
 * hidden), output between two reads is not seen, and the grid is the pane's own, never
 * the browser's. It is a stopgap that ends when herdr reports attach.
 */
import { HerdrError } from "./herdr/client.ts";

/** between reads while the screen is changing, and the ceiling it relaxes to while it is not */
export const MIRROR_ACTIVE_MS = 80;
export const MIRROR_IDLE_MS = 400;
/** how soon the screen is read after something was typed: the echo is what the typist waits for */
export const MIRROR_ECHO_MS = 15;
/** how often the whole screen goes out while it changes: a client's screen that drifted is whole again by then */
export const MIRROR_WHOLE_MS = 10_000;
/** how often the pane's size is asked for: herdr announces no layout change this server listens to */
export const MIRROR_SIZE_MS = 2000;
/** reads in a row that herdr did not answer before the mirror ends as a terminal would */
const MIRROR_FAILURES = 10;

export interface MirrorOptions {
  /** the pane's visible screen with its escape sequences */
  read: () => Promise<string>;
  /** bytes for the pane, as typing into a pty would be */
  write: (data: string) => Promise<unknown>;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  /** the grid the mirror starts on, and the pane's grid now (null when herdr's layout has none for it) */
  cols: number;
  rows: number;
  size?: () => Promise<{ cols: number; rows: number } | null>;
  /** the pane changed size on its PC: called before the screen is painted again for the new grid */
  onResize?: (cols: number, rows: number) => void;
  activeMs?: number;
  idleMs?: number;
  sizeMs?: number;
  echoMs?: number;
  wholeMs?: number;
}

/** One screen as bytes for xterm: home, clear, the rows; the last row has no newline, which would scroll. */
export function mirrorFrame(screen: string): string {
  const rows = screen.replace(/(?:\r?\n)+$/, "").replace(/\r?\n/g, "\r\n");
  return `\x1b[?25l\x1b[0m\x1b[H\x1b[2J${rows}\x1b[0m`;
}

const rowsOf = (screen: string): string[] => screen.replace(/(?:\r?\n)+$/, "").split(/\r?\n/);

/**
 * The rows of `after` that differ from `before`, each cleared and drawn in its place. herdr's
 * read starts every row from plain text (a row's colours end with it), so a row stands alone.
 * Line wrap is off while they are drawn: a row xterm counts wider than herdr did would run
 * into the row below, which is not drawn again until it changes.
 *
 * A read can hold more rows than the grid (seen on a headless herdr after a split: the layout
 * said 20 rows, the read gave 40). A whole frame scrolls those through and leaves the last
 * `gridRows` on the screen, so the rows compared here are those same last ones.
 */
export function mirrorRows(before: string, after: string, gridRows: number): string {
  const was = rowsOf(before).slice(-gridRows);
  const now = rowsOf(after).slice(-gridRows);
  let frame = "\x1b[?25l\x1b[?7l";
  for (let row = 0; row < Math.max(was.length, now.length); row++) {
    if (was[row] === now[row]) continue;
    frame += `\x1b[${row + 1};1H\x1b[0m\x1b[2K${now[row] ?? ""}`;
  }
  return `${frame}\x1b[0m\x1b[?7h`;
}

export class MirrorSession {
  readonly exited: Promise<void>;
  private finish!: () => void;
  private closed = false;
  private paused = false;
  /** the screen as last read, and as last sent: they differ while output is paused */
  private screen: string | null = null;
  private sent: string | null = null;
  private failures = 0;
  private delay: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cols: number;
  private rows: number;
  private sizedAt = Date.now();
  /** when the whole screen last went out */
  private wholeAt = 0;
  private reading = false;
  /** something was typed while a read was on its way: the next read follows at once */
  private poked = false;

  constructor(private readonly options: MirrorOptions) {
    this.exited = new Promise((resolve) => { this.finish = resolve; });
    this.delay = options.activeMs ?? MIRROR_ACTIVE_MS;
    this.cols = options.cols;
    this.rows = options.rows;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.closed) return;
    const active = this.options.activeMs ?? MIRROR_ACTIVE_MS;
    const idle = this.options.idleMs ?? MIRROR_IDLE_MS;
    this.reading = true;
    if (this.options.size && Date.now() - this.sizedAt >= (this.options.sizeMs ?? MIRROR_SIZE_MS)) {
      this.sizedAt = Date.now();
      const size = await this.options.size().catch(() => null);
      if (this.closed) return;
      if (size && (size.cols !== this.cols || size.rows !== this.rows)) {
        this.cols = size.cols;
        this.rows = size.rows;
        this.options.onResize?.(size.cols, size.rows);
        // the clients' grids were cleared by the resize: the next screen goes out even if unchanged
        this.sent = null;
      }
    }
    try {
      this.screen = await this.options.read();
      this.failures = 0;
    } catch (error) {
      this.reading = false;
      if (this.closed) return;
      // herdr answered that the pane is not there: the terminal ended. A herdr that does
      // not answer at all gets a few more tries first.
      const gone = error instanceof HerdrError && error.code !== "connect_failed" && error.code !== "timeout";
      if (gone || ++this.failures >= MIRROR_FAILURES) {
        this.closed = true;
        this.finish();
        this.options.onExit(null);
        return;
      }
      this.timer = setTimeout(() => void this.tick(), idle);
      return;
    }
    this.reading = false;
    if (this.closed) return;
    this.delay = this.flush() ? active : Math.min(idle, Math.ceil(this.delay * 1.5));
    if (this.poked) {
      this.poked = false;
      this.delay = active;
      this.timer = setTimeout(() => void this.tick(), this.options.echoMs ?? MIRROR_ECHO_MS);
      return;
    }
    this.timer = setTimeout(() => void this.tick(), this.delay);
  }

  /** Sends the screen if it is not the one last sent: its changed rows, or all of it when a client's screen cannot be built on. */
  private flush(): boolean {
    if (this.paused || this.screen === null || this.screen === this.sent) return false;
    const all = mirrorFrame(this.screen);
    const due = this.sent === null || Date.now() - this.wholeAt >= (this.options.wholeMs ?? MIRROR_WHOLE_MS);
    const rows = due ? null : mirrorRows(this.sent!, this.screen, this.rows);
    // a screen that scrolled changed every row, and each row drawn in its place costs more than the screen whole
    const whole = rows === null || rows.length >= all.length;
    const frame = whole ? all : rows;
    if (whole) this.wholeAt = Date.now();
    this.sent = this.screen;
    this.options.onData(frame);
    return true;
  }

  /**
   * Something was typed into the pane: its echo is read now, not at the next read of an idle
   * screen, up to 400 ms away.
   */
  poke(): void {
    if (this.closed) return;
    if (this.reading) { this.poked = true; return; }
    clearTimeout(this.timer);
    this.delay = this.options.activeMs ?? MIRROR_ACTIVE_MS;
    this.timer = setTimeout(() => void this.tick(), this.options.echoMs ?? MIRROR_ECHO_MS);
  }

  /** The screen last sent, whole, for a client joining now: a stream tail could cut a large one in two. */
  get current(): string | null {
    return this.sent === null ? null : mirrorFrame(this.sent);
  }

  write(data: string): void {
    if (this.closed) return;
    void this.options.write(data).then(() => this.poke(), () => undefined);
  }

  /** The grid is the pane's own in herdr; nothing here can resize it. */
  resize(_cols: number, _rows: number): void {}

  pause(): void {
    this.paused = true;
  }

  /** A paused client missed nothing it needs: only the latest screen matters. */
  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.flush();
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.finish();
  }
}
