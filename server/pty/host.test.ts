import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ptyHost, RUST_SIDECAR_BUILD, rustSidecar } from "./host.ts";
import { PtySession, type PtySessionOptions } from "./session.ts";

const built = existsSync(RUST_SIDECAR_BUILD);
const LIMIT_MS = 10_000;

describe("ptyHost", () => {
  it("runs the Node sidecar unless OVIS_PTY_SIDECAR=rust asks for the Rust one", () => {
    expect(ptyHost("pty-host.mjs", {})).toEqual(["node", "pty-host.mjs"]);
    expect(ptyHost("pty-host.mjs", { OVIS_PTY_SIDECAR: "node" })).toEqual(["node", "pty-host.mjs"]);
  });

  it("falls back to the Node sidecar when the Rust binary is missing, saying so at most once", () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: join(tmpdir(), `ovis-no-pty-sidecar-${crypto.randomUUID()}`) };
      expect(ptyHost("pty-host.mjs", env)).toEqual(["node", "pty-host.mjs"]);
      expect(rustSidecar(env)).toBeNull();
      expect(said.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { said.mockRestore(); }
  });

  it.skipIf(!built)("runs the Rust build, or OVIS_PTY_SIDECAR_BIN, when asked", () => {
    expect(ptyHost("pty-host.mjs", { OVIS_PTY_SIDECAR: "rust" })).toEqual([RUST_SIDECAR_BUILD]);
    expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: RUST_SIDECAR_BUILD })).toBe(RUST_SIDECAR_BUILD);
  });
});

interface Run {
  session: PtySession;
  output: () => string;
  until: (label: string, check: (output: string) => boolean) => Promise<void>;
  /** onExit's code; a killed session never reports one */
  exited: Promise<number | null>;
}

function run(command: string, args: string[], extra: Partial<PtySessionOptions> = {}): Run {
  let output = "";
  const waiters = new Set<() => void>();
  let reportExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => { reportExit = resolve; });
  const session = new PtySession({
    command, args, cols: 80, rows: 24, ...extra,
    onData: (data) => {
      output += data;
      for (const waiter of [...waiters]) waiter();
    },
    onExit: (code) => reportExit(code),
  });
  const until = (label: string, check: (output: string) => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(test);
      reject(new Error(`no ${label} in ${LIMIT_MS} ms: ${JSON.stringify(output.slice(-200))}`));
    }, LIMIT_MS);
    const test = () => {
      if (!check(output)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  return { session, output: () => output, until, exited };
}

/** Resolves once `path` exists: the command's own word that it got that far, whatever the pty carried. */
async function appears(path: string): Promise<void> {
  const watcher = watch(dirname(path));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${basename(path)} never appeared`)), LIMIT_MS);
      const check = () => {
        if (!existsSync(path)) return;
        clearTimeout(timer);
        resolve();
      };
      watcher.on("change", check);
      check();
    });
  } finally { watcher.close(); }
}

/** The same checks on each host: the Rust one has to behave as the Node one does. */
function parity(host: "node" | "rust") {
  describe.skipIf(host === "rust" && !built)(`PtySession on the ${host} PTY host`, () => {
    const previous = process.env["OVIS_PTY_SIDECAR"];
    beforeAll(() => {
      if (host === "rust") process.env["OVIS_PTY_SIDECAR"] = "rust";
      else delete process.env["OVIS_PTY_SIDECAR"];
    });
    afterAll(() => {
      if (previous === undefined) delete process.env["OVIS_PTY_SIDECAR"];
      else process.env["OVIS_PTY_SIDECAR"] = previous;
    });

    it("starts that host and hands the command its environment without the bridge token", async () => {
      const token = `ovis-host-token-fixture-${crypto.randomUUID()}`;
      const kept = process.env["OVIS_TOKEN"];
      process.env["OVIS_TOKEN"] = token;
      const spawn = spyOn(Bun, "spawn");
      let started: Run | undefined;
      try {
        started = run("sh", ["-c", 'printf "[%s|%s|%s|%s]" "$HERDR_SOCKET_PATH" "$TERM" "${OVIS_TOKEN-unset}" "${HERDR_WEB_TOKEN-unset}"'], {
          env: { HERDR_SOCKET_PATH: "/tmp/ovis-host-parity.sock", HERDR_WEB_TOKEN: token },
        });
        expect(await started.exited).toBe(0);
        const argv = (spawn.mock.calls[0] as unknown as [string[]])[0];
        expect(argv[0]).toBe(host === "rust" ? RUST_SIDECAR_BUILD : "node");
        expect(started.output()).toContain("[/tmp/ovis-host-parity.sock|xterm-256color|unset|unset]");
        // compared as a boolean so a failure never prints the token
        expect(started.output().includes(token)).toBe(false);
      } finally {
        started?.session.kill();
        spawn.mockRestore();
        if (kept === undefined) delete process.env["OVIS_TOKEN"];
        else process.env["OVIS_TOKEN"] = kept;
      }
    }, 15_000);

    it("delivers split UTF-8 and the entire final burst before reporting the exit code", async () => {
      const expected = "한글🙂\u001b[31m끝\u001b[0m".repeat(100_000);
      const burst = run("node", ["-e", `
        const data = Buffer.from("한글🙂\\x1b[31m끝\\x1b[0m".repeat(100000));
        process.stdout.write(data.subarray(0, 1));
        setTimeout(() => process.stdout.write(data.subarray(1), () => process.exit(7)), 10);
      `]);
      try {
        expect(await burst.exited).toBe(7);
        expect(burst.output() === expected).toBe(true);
      } finally { burst.session.kill(); }
    }, 15_000);

    it.skipIf(process.platform === "win32")("signals SIGWINCH to the command without changing its size", async () => {
      const winch = run("node", ["-e", `
        process.on("SIGWINCH", () => process.stdout.write("WINCH " + process.stdout.columns + "x" + process.stdout.rows, () => process.exit(0)));
        process.stdout.write("READY");
        setInterval(() => {}, 1000);
      `], { cols: 40, rows: 5 });
      try {
        await winch.until("READY", (output) => output.includes("READY"));
        winch.session.winch();
        expect(await winch.exited).toBe(0);
        expect(winch.output()).toContain("WINCH 40x5");
      } finally { winch.session.kill(); }
    }, 15_000);

    it.skipIf(process.platform === "win32")("resizes the pty, and the command hears it", async () => {
      // process.stdout first: its own SIGWINCH listener, which refreshes the size, has to run before ours
      const resized = run("node", ["-e", `
        const out = process.stdout;
        process.on("SIGWINCH", () => out.write("WINCH " + out.columns + "x" + out.rows, () => process.exit(0)));
        out.write("READY");
        setInterval(() => {}, 1000);
      `], { cols: 40, rows: 5 });
      try {
        await resized.until("READY", (output) => output.includes("READY"));
        resized.session.resize(60, 10);
        expect(await resized.exited).toBe(0);
        expect(resized.output()).toContain("WINCH 60x10");
      } finally { resized.session.kill(); }
    }, 15_000);

    it("holds output while paused with input live, and delivers it all on resume", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ovis-pty-pause-"));
      const wrote = join(dir, "wrote");
      const interrupted = join(dir, "interrupted");
      const held = "B".repeat(1000);
      const paused = run("node", ["-e", `
        const fs = require("fs");
        process.stdin.setRawMode(true);
        process.stdin.on("data", (data) => {
          const text = data.toString();
          if (text.includes("\\x03")) fs.writeFileSync(${JSON.stringify(interrupted)}, "");
          if (text.includes("go")) process.stdout.write("B".repeat(1000), () => fs.writeFileSync(${JSON.stringify(wrote)}, ""));
          if (text.includes("q")) process.stdout.write("END", () => process.exit(0));
        });
        process.stdout.write("READY");
      `]);
      try {
        await paused.until("READY", (output) => output.includes("READY"));
        paused.session.pause();
        paused.session.write("go");
        await appears(wrote);
        expect(paused.output()).not.toContain("B");
        paused.session.write("\x03");
        await appears(interrupted);
        expect(paused.output()).not.toContain("B");
        paused.session.resume();
        await paused.until("the held output", (output) => output.includes(held));
        paused.session.write("q");
        expect(await paused.exited).toBe(0);
        expect(paused.output()).toEndWith("END");
      } finally {
        paused.session.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("writes a lone surrogate as U+FFFD, the way JavaScript encodes it", async () => {
      const echo = run("node", ["-e", `
        process.stdin.setRawMode(true);
        process.stdin.once("data", (data) => process.stdout.write("HEX:" + data.toString("hex"), () => process.exit(0)));
        process.stdout.write("READY");
      `]);
      try {
        await echo.until("READY", (output) => output.includes("READY"));
        echo.session.write("a\ud83db");
        expect(await echo.exited).toBe(0);
        expect(echo.output()).toContain("HEX:61efbfbd62");
      } finally { echo.session.kill(); }
    }, 15_000);

    it("reaps both processes when killed with output paused", async () => {
      const tag = `ovis-pty-reap-${crypto.randomUUID()}`;
      const flood = run("node", ["-e", `/* ${tag} */ setInterval(() => process.stdout.write("x".repeat(4096)), 5);`]);
      try {
        await flood.until("output", (output) => output.length > 0);
        flood.session.pause();
        flood.session.kill();
        await flood.session.exited;
        expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.length).toBe(0);
      } finally { flood.session.kill(); }
    }, 15_000);

    // the Node host exits right after its SIGKILL, so only the Rust one promises the reap
    it.skipIf(host !== "rust")("exits only after reaping a command that ignores SIGHUP", async () => {
      const tag = `ovis-pty-stubborn-${crypto.randomUUID()}`;
      const stubborn = run("node", ["-e", `/* ${tag} */ process.on("SIGHUP", () => {}); process.stdout.write("READY"); setInterval(() => {}, 1000);`]);
      try {
        await stubborn.until("READY", (output) => output.includes("READY"));
        stubborn.session.kill();
        await stubborn.session.exited;
        expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.length).toBe(0);
      } finally { stubborn.session.kill(); }
    }, 15_000);
  });
}

parity("node");
parity("rust");
