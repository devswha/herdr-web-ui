import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolate, lock, plan } from "./check.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "hwc-test-")); made.push(dir); return dir; };

describe("plan", () => {
  it("reads the modes: the fast steps, the lanes, both, or one command", () => {
    expect(plan(["fast"])).toEqual({ fast: true, lanes: [], command: null });
    expect(plan(["browser"])).toEqual({ fast: false, lanes: ["browser"], command: null });
    expect(plan(["browser", "integration"])).toEqual({ fast: false, lanes: ["integration", "browser"], command: null });
    expect(plan(["full"])).toEqual({ fast: true, lanes: ["integration", "browser"], command: null });
    expect(plan(["run", "bun", "test", "./a.test.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "test", "./a.test.ts"] });
  });

  it("refuses what it does not know instead of running something else", () => {
    for (const args of [[], ["quick"], ["fast", "run"], ["run"]]) expect(() => plan(args)).toThrow("Usage");
  });
});

describe("isolate", () => {
  it("points herdr, its plugins and the web UI at one directory of the run's own, under its own session name", () => {
    const first = isolate({ PATH: "/bin", XDG_CONFIG_HOME: "/home/someone/.config" });
    const second = isolate({ PATH: "/bin" });
    try {
      expect(first.env["PATH"]).toBe("/bin");
      expect(first.env["XDG_CONFIG_HOME"]).not.toBe("/home/someone/.config");
      for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_WEB_STATE_DIR"]) {
        expect(existsSync(first.env[name]!)).toBe(true);
        expect(first.env[name]).not.toBe(second.env[name]);
      }
      expect(first.sessions).toBe(join(first.env["XDG_CONFIG_HOME"]!, "herdr", "sessions"));
      expect(first.env["HERDR_TEST_SESSION"]).toMatch(/^check-[0-9a-f]{6}$/);
      expect(first.env["HERDR_TEST_SESSION"]).not.toBe(second.env["HERDR_TEST_SESSION"]);
      // one integration file at a time unless asked otherwise
      expect(first.env["HERDR_TEST_SHARDS"]).toBe("1");
      expect(isolate({ HERDR_TEST_SHARDS: "4" }, scratch()).env["HERDR_TEST_SHARDS"]).toBe("4");
    } finally {
      const dir = join(first.env["XDG_CONFIG_HOME"]!, "..");
      first.remove();
      second.remove();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("keeps a directory the caller named, and refuses one too long for a socket", () => {
    const kept = scratch();
    const isolation = isolate({}, kept);
    expect(isolation.env["XDG_CONFIG_HOME"]).toBe(join(kept, "config"));
    isolation.remove();
    expect(existsSync(join(kept, "config"))).toBe(true);
    expect(() => isolate({}, join(scratch(), "a".repeat(80)))).toThrow("too long for a unix socket");
  });

  it("refuses to run in the herdr the user works in", () => {
    expect(() => isolate({ HERDR_TEST_LIVE: "1" }, scratch())).toThrow("HERDR_TEST_LIVE");
  });
});

describe("lock", () => {
  it("lets one run in, names the run that holds it, and is free again once released", () => {
    const path = join(scratch(), "check.lock");
    const first = lock(path, 111, () => true);
    expect("release" in first).toBe(true);
    expect(lock(path, 222, () => true)).toEqual({ heldBy: 111 });
    (first as { release: () => void }).release();
    expect("release" in lock(path, 222, () => true)).toBe(true);
  });

  it("takes over a lock whose run is gone", () => {
    const path = join(scratch(), "check.lock");
    lock(path, 111, () => true);
    const next = lock(path, 222, (pid) => pid !== 111);
    expect("release" in next).toBe(true);
    expect(lock(path, 333, () => true)).toEqual({ heldBy: 222 });
  });
});
