export interface PtySessionOptions {
  command: string;
  args: string[];
  cols: number;
  rows: number;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  env?: Record<string, string>;
}

export type PtyEvent =
  | { readonly type: "pause" | "resume" | "kill"; readonly sessionId: number; readonly paneId: "fake-pane" }
  | { readonly type: "exit"; readonly sessionId: number; readonly paneId: "fake-pane"; readonly code: number | null };
export type PtyEventType = PtyEvent["type"];

const listeners = new Set<(event: PtyEvent) => void>();
let nextSessionId = 1;
let queuedInitialOutput: string[] = [];

export function queueInitialOutput(...chunks: string[]): void {
  queuedInitialOutput.push(...chunks);
}

export function onPtyEvent(listener: (event: PtyEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export class FakePtySession {
  readonly sessionId = nextSessionId++;
  readonly writes: string[] = [];
  readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
  pauseCount = 0;
  resumeCount = 0;
  killCount = 0;
  private paused = false;
  private closed = false;
  private resumeOutput: string | undefined;
  private exitCallback: ((code: number | null) => void) | undefined;
  private readonly exitedResolver: { resolve: () => void };
  readonly exited: Promise<void>;

  constructor(private readonly options: PtySessionOptions) {
    const resolver: { resolve: () => void } = { resolve: () => {} };
    this.exitedResolver = resolver;
    this.exited = new Promise<void>((resolve) => {
      resolver.resolve = resolve;
    });
    this.exitCallback = options.onExit;
    for (const chunk of queuedInitialOutput) options.onData(chunk);
    queuedInitialOutput = [];
  }

  emitData(data: string): void {
    if (!this.closed) this.options.onData(data);
  }

  queueOutputOnResume(data: string): void {
    this.resumeOutput = data;
  }

  write(data: string): void {
    if (!this.closed) this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.resizes.push({ cols, rows });
  }

  pause(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.pauseCount++;
    this.emitEvent({ type: "pause", sessionId: this.sessionId, paneId: "fake-pane" });
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    this.paused = false;
    this.resumeCount++;
    this.emitEvent({ type: "resume", sessionId: this.sessionId, paneId: "fake-pane" });
    const output = this.resumeOutput;
    this.resumeOutput = undefined;
    if (output !== undefined) this.options.onData(output);
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.killCount++;
    this.emitEvent({ type: "kill", sessionId: this.sessionId, paneId: "fake-pane" });
    this.exitCallback?.(null);
    this.exitCallback = undefined;
    this.emitEvent({ type: "exit", sessionId: this.sessionId, paneId: "fake-pane", code: null });
    this.exitedResolver.resolve();
  }

  private emitEvent(event: PtyEvent): void {
    for (const listener of listeners) listener(event);
  }
}
