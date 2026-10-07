/**
 * What a rejected promise nobody awaits does to a long-running server.
 *
 * Bun logs one and keeps going, which is the right default, but a fire-and-forget task
 * that rejects stops doing its work: a mirror loop that never reschedules (server/mirror.ts),
 * a push delivery that silently stops. One handler here says so once, with the reason, and
 * never swallows anything — the promise still ends rejected for anyone who attached to it.
 */

let installed = false;

/** Idempotent: every `createServer` in a test run calls this, and one listener is enough. */
export function installRejectionLogging(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    console.error(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}