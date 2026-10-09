interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => unknown;
  setTimeout: (callback: () => void) => unknown;
}

const browserScheduler: FrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  setTimeout: (callback) => window.setTimeout(callback, 0),
};

/**
 * Disposes an xterm Terminal once the callbacks it has already scheduled have run.
 *
 * xterm 5.5 never cancels them: `reset()` asks for a frame and the Viewport a task, both calling
 * `Viewport.syncScrollArea`, which reads the renderer's dimensions. Disposed, the terminal has no
 * renderer, and the callback threw "Cannot read properties of undefined (reading 'dimensions')":
 * every time a pane was switched (reset, then a fit) and its terminal unmounted before the next
 * frame, and on return to a hidden tab, where frames wait. Frames run in the order they were asked
 * for, so a frame asked for now runs after xterm's; the task after it runs after xterm's task.
 */
export function disposeAfterPendingFrame(term: { dispose: () => void }, scheduler: FrameScheduler = browserScheduler): void {
  scheduler.requestAnimationFrame(() => {
    scheduler.setTimeout(() => term.dispose());
  });
}
