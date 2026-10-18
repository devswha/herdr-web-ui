import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_SESSION, testSocketPath } from "./test-herdr.ts";

const socket = (root: string): string => join(root, "herdr", "sessions", TEST_SESSION, "herdr.sock");

describe("demo fixture isolation", () => {
  for (const mode of ["live", "missing-binary", "unit", "cached-session", "isolated"] as const) {
    const isolated = mode === "isolated";
    it(isolated ? "accepts only the dedicated demo socket before starting staging" : `rejects ${mode} staging before any RPC or fixture mutation`, () => {
      const root = mkdtempSync(join(tmpdir(), "demo-stage-guard-"));
      try {
        const invoked = join(root, "rpc-invoked");
        const stage = fileURLToPath(new URL("./demo/stage.ts", import.meta.url));
        const result = spawnSync(process.execPath, ["--eval", `
          const { mock } = await import("bun:test");
          const fs = await import("node:fs");
          const record = fs.writeFileSync;
          // Block both daemon connections and staging writes, even if their order regresses.
          const blocked = () => { record(${JSON.stringify(invoked)}, "called"); throw new Error("side effect blocked by test"); };
          mock.module("node:fs", () => ({ ...fs, mkdirSync: blocked, mkdtempSync: blocked, rmSync: blocked, writeFileSync: blocked }));
          Bun.connect = blocked;
          ${mode === "cached-session" ? `await import(${JSON.stringify(fileURLToPath(new URL("./test-herdr.ts", import.meta.url)))});` : ""}
          const { stage } = await import(${JSON.stringify(stage)});
          await stage();
        `], {
          encoding: "utf8", timeout: 5_000,
          env: {
            ...process.env, TMPDIR: root, XDG_CONFIG_HOME: root, PATH: root,
            HERDR_SOCKET: isolated || mode === "cached-session"
              ? join(root, "herdr", "sessions", isolated ? "herdr-web-ui-demo" : "not-the-demo", "herdr.sock")
              : join(root, "not-the-demo.sock"),
            HERDR_TEST_SESSION: "not-the-demo",
            HERDR_WEB_HERDR_BIN: "",
            HERDR_TEST_LIVE: mode === "live" || isolated ? "1" : "",
            HERDR_TEST_MODE: mode === "unit" ? "unit" : "integration",
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(isolated ? "side effect blocked by test" : "isolated demo session");
        expect(existsSync(invoked)).toBe(isolated);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 20_000);
  }
});

describe("testSocketPath", () => {
  it("follows XDG_CONFIG_HOME first, on Windows too", () => {
    expect(testSocketPath({ XDG_CONFIG_HOME: "/x", APPDATA: "/a" }, "win32")).toBe(socket("/x"));
    expect(testSocketPath({ XDG_CONFIG_HOME: "/x" }, "linux")).toBe(socket("/x"));
  });

  it("uses APPDATA on Windows without it, and ~/.config elsewhere", () => {
    expect(testSocketPath({ APPDATA: "/a" }, "win32")).toBe(socket("/a"));
    expect(testSocketPath({ XDG_CONFIG_HOME: "", APPDATA: "" }, "win32")).toBe(socket(join(homedir(), "AppData", "Roaming")));
    expect(testSocketPath({ APPDATA: "/a" }, "darwin")).toBe(socket(join(homedir(), ".config")));
  });
});
