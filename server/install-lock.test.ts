import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSIX_INSTALL_LOCK } from "./remote-host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function acquire() {
  const base = mkdtempSync(join(tmpdir(), "install-lock-"));
  dirs.push(base);
  const lock = join(base, "install.lock");
  const run = () => Bun.spawnSync(["sh", "-c", `set -eu; base=${JSON.stringify(base)}; ${POSIX_INSTALL_LOCK} printf acquired`]);
  return { lock, run };
}

describe("POSIX install lock", () => {
  it("takes a free lock and records its owner", () => {
    const { lock, run } = acquire();
    const result = run();
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(lock, "pid"))).toBe(true);
  });

  it("refuses a lock held by a live installer", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const result = run();
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Another installation is in progress");
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
  });

  it("reclaims a lock whose owner is gone", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "pid"), "utf8")).not.toBe("2147483646");
  });

  it("reclaims a lock older than any install can run, even with a live owner", () => {
    const { lock, run } = acquire();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    const old = new Date(Date.now() - 40 * 60_000);
    utimesSync(lock, old, old);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(lock, "pid"), "utf8")).not.toBe(String(process.pid));
  });
});
