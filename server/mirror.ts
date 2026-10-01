/**
 * A terminal for a herdr that cannot `terminal attach` (Windows, herdrdev/herdr#4821).
 * There is no byte stream to forward, so the pane's visible screen is read a few times a
 * second (`pane.read`, ansi) and each changed screen goes out as one whole repaint, in the
 * same `pty-data` frames a real attach sends. It stands where a PtySession stands, so
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
}

/** One screen as bytes for xterm: home, clear, the rows; the last row has no newline, which would scroll. */
export function mirrorFrame(screen: string): string {
  const rows = screen.replace(/(?:\r?\n)+$/, "").replace(/\r?\n/g, "\r\n");
  return `\x1b[?25l\x1b[0m\x1b[H\x1b[2J${rows}\x1b[0m`;
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
    if (this.closed) return;
    this.delay = this.flush() ? active : Math.min(idle, Math.ceil(this.delay * 1.5));
    this.timer = setTimeout(() => void this.tick(), this.delay);
  }

  /** Sends the screen if it is not the one last sent. */
  private flush(): boolean {
    if (this.paused || this.screen === null || this.screen === this.sent) return false;
    this.sent = this.screen;
    this.options.onData(mirrorFrame(this.screen));
    return true;
  }

  /** The screen last sent, whole, for a client joining now: a stream tail could cut a large one in two. */
  get current(): string | null {
    return this.sent === null ? null : mirrorFrame(this.sent);
  }

  write(data: string): void {
    if (this.closed) return;
    void this.options.write(data).catch(() => undefined);
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
