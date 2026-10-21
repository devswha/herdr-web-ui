#!/usr/bin/env node
/**
 * PTY host: runs ONE command on a real pseudo-terminal and bridges it to its parent.
 *
 * Bun.Terminal exists, but Bun 1.4.2 has no public output pause/resume API.
 * node-pty supplies that control so browser acknowledgements can stop PTY reads.
 * Keep it in Node: loading node-pty in Bun has panicked (oven-sh/bun#18546).
 * It comes as @lydell/node-pty, node-pty 1.1.0 repackaged with a prebuilt binary per
 * platform (Linux x64/arm64, macOS, Windows), so installing never runs node-gyp: a PC
 * without Python and a C++ toolchain installs the same as one with them.
 *
 * Protocol
 *   argv:   <cols> <rows> <command> [args...]
 *           or --wait: started ahead of need (Node and node-pty load before anyone waits on
 *           them); the command comes in the first frame
 *             {"t":"s","c":<cols>,"r":<rows>,"cmd":"<command>","args":[...],"env":{...}}
 *   stdin:  newline-delimited JSON control frames
 *             {"t":"i","d":"<text>"}          write text into the pty
 *             {"t":"r","c":<cols>,"r":<rows>} resize the pty
 *             {"t":"p","paused":true|false} pause/resume output (input stays live)
 *             {"t":"w"}                       signal SIGWINCH to the child at its current size
 *   stdout: raw pty bytes, unmodified
 *   stderr: diagnostics only
 *   exit:   mirrors the child's exit code
 */

import * as pty from "@lydell/node-pty";

const waiting = process.argv[2] === "--wait";
const [colsRaw, rowsRaw, command, ...args] = process.argv.slice(2);
if (!waiting && !command) {
  process.stderr.write("pty-host: usage: pty-host.mjs <cols> <rows> <command> [args...] | --wait\n");
  process.exit(2);
}

/** @type {import("@lydell/node-pty").IPty | null} */
let term = null;
let parentPaused = false;
let stdoutBlocked = false;
let exited = false;
function updateReading() {
  if (!term) return;
  if (parentPaused || stdoutBlocked) term.pause();
  else term.resume();
}

function start(colsValue, rowsValue, file, argv, env) {
  const cols = Number.parseInt(String(colsValue ?? ""), 10);
  const rows = Number.parseInt(String(rowsValue ?? ""), 10);
  term = pty.spawn(file, argv, {
    name: "xterm-256color",
    cols: Number.isFinite(cols) && cols > 0 ? cols : 80,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 24,
    cwd: env.HOME ?? "/",
    env: { ...env, TERM: "xterm-256color" },
  });
  term.onData((chunk) => {
    if (!process.stdout.write(chunk)) {
      stdoutBlocked = true;
      updateReading();
    }
  });
  term.onExit(({ exitCode }) => {
    exited = true;
    // Let the native exit callback unwind and stdout drain before Node exits.
    process.exitCode = exitCode ?? 0;
    process.stdin.destroy();
    process.stdout.end();
  });
  updateReading();
}
process.stdout.on("drain", () => {
  stdoutBlocked = false;
  updateReading();
});

if (!waiting) start(colsRaw, rowsRaw, command, args, process.env);

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index = pending.indexOf("\n");
  while (index !== -1) {
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (line) handle(line);
    index = pending.indexOf("\n");
  }
});

function handle(line) {
  if (exited) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  try {
    if (!term) {
      // a waiting host takes its command first; nothing else means anything before it
      if (frame.t !== "s" || typeof frame.cmd !== "string" || !Array.isArray(frame.args)) return;
      try {
        start(frame.c, frame.r, frame.cmd, frame.args.map(String), frame.env && typeof frame.env === "object" ? frame.env : process.env);
      } catch (error) {
        // as a host started with its command would: a command that cannot start ends it
        process.stderr.write(`pty-host: ${error?.message ?? error}\n`);
        process.exit(1);
      }
      return;
    }
    if (frame.t === "i" && typeof frame.d === "string") term.write(frame.d);
    else if (frame.t === "r") term.resize(clamp(frame.c), clamp(frame.r));
    // a resize to the same size changes nothing the kernel signals: the child is told directly
    else if (frame.t === "w") { if (process.platform !== "win32") process.kill(term.pid, "SIGWINCH"); }
    else if (frame.t === "p" && typeof frame.paused === "boolean") {
      parentPaused = frame.paused;
      updateReading();
    }
  } catch (error) {
    process.stderr.write(`pty-host: ${error?.message ?? error}\n`);
  }
}

function clamp(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

let stopping = false;
const stop = () => {
  // a host that never got its command has nothing to end
  if (!term) process.exit(0);
  if (!exited && !stopping) {
    stopping = true;
    try {
      term.kill();
      // A paused reader still needs to observe EOF after the parent leaves.
      term.resume();
    } catch {
      /* already gone */
    }
    // A child can ignore SIGHUP, and a blocked pipe must not pin the sidecar.
    setTimeout(() => {
      if (!exited) { try { term.kill("SIGKILL"); } catch { /* already gone */ } }
      process.exit(0);
    }, 2000).unref();
  }
};
process.on("SIGTERM", () => { stop(); process.stdin.destroy(); });
process.on("SIGINT", () => { stop(); process.stdin.destroy(); });
process.stdin.on("close", stop);
// The parent can disappear while output is in flight. Close the owned attach
// instead of turning the expected broken pipe into an uncaught Node exception.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") process.stderr.write(`pty-host: ${error.message}\n`);
  stop();
  process.stdin.destroy();
});
