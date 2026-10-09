import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const script = join(import.meta.dir, "with-bun.sh");
const preflight = join(import.meta.dir, "preflight.sh");

describe.skipIf(process.platform === "win32")("Unix Bun discovery", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "with-bun-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function tool(dir: string, name: string, version: string) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; else printf '%s\\n' "$@"; fi\n`);
    chmodSync(file, 0o755);
  }

  async function run(command: string[], overrides: Record<string, string> = {}) {
    const child = Bun.spawn(command, {
      cwd: root,
      env: { HOME: home, PATH: "/usr/bin:/bin", ...overrides },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { out, err, code };
  }

  it("finds ~/.bun/bin and preserves argument boundaries with a bare PATH", async () => {
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "scripts/plugin.ts", "two words", ""]);
    expect(result.code).toBe(0);
    expect(result.out).toBe("scripts/plugin.ts\ntwo words\n\n");
  });

  it("finds Bun in BUN_INSTALL when it is outside the default home", async () => {
    tool(join(home, "custom", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "--version"], { BUN_INSTALL: join(home, "custom") });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("1.4.2");
  });

  it("keeps the Bun already on PATH ahead of fallback locations", async () => {
    tool(join(home, "chosen"), "bun", "1.4.3");
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const result = await run(["/bin/sh", script, "--version"], { PATH: `${join(home, "chosen")}:/usr/bin:/bin` });
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("1.4.3");
  });

  it("exits 127 when Bun is missing from PATH and the configured locations", async () => {
    const result = await run(["/bin/sh", script, "x"], { WITH_BUN_EXTRA_DIRS: join(home, "missing") });
    expect(result.code).toBe(127);
    expect(result.out).toBe("");
  });

  it("preflight finds Bun and Node from extra locations with a bare PATH", async () => {
    const bunDir = join(home, ".bun", "bin"), nodeDir = join(home, "node");
    tool(bunDir, "bun", "1.4.2");
    tool(nodeDir, "node", "v22.0.0");
    const result = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: `${bunDir} ${nodeDir}` });
    expect(result.code).toBe(0);
    expect(result.out).toBe("");
    expect(result.err).toBe("");
  });

  it.each(["0.9.0", "1.3.9", "1.4.0", "1.4.2", "2.0.0"])("keeps preflight's Bun version behavior for %s", async version => {
    const dir = join(home, ".bun", "bin");
    tool(dir, "bun", version);
    tool(dir, "node", "v22.0.0");
    const result = await run(["/bin/sh", preflight], { WITH_BUN_EXTRA_DIRS: dir });
    expect(result.code).toBe(version === "0.9.0" || version === "1.3.9" ? 1 : 0);
  });

  it("routes each Unix Bun entry through the launcher without changing its arguments", async () => {
    const manifest: Record<string, { command: string[]; platforms?: string[] }[]> =
      Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8"));
    tool(join(home, ".bun", "bin"), "bun", "1.4.2");
    const commands = ["build", "startup", "actions", "panes"].flatMap(section =>
      manifest[section].filter(entry => entry.platforms?.includes("linux") && entry.command[1] !== "scripts/preflight.sh"
        && entry.command[0] !== "herdr").map(entry => entry.command));
    expect(commands).toEqual([
      ["sh", "scripts/with-bun.sh", "install"],
      ["sh", "scripts/with-bun.sh", "run", "build"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin.ts", "start"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin.ts", "start"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin.ts", "stop"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin.ts", "status"],
      ["sh", "scripts/with-bun.sh", "scripts/plugin.ts", "phone-setup"],
    ]);
    for (const command of commands) {
      const result = await run(command);
      expect(result.code).toBe(0);
      expect(result.out).toBe(command.slice(2).join("\n") + "\n");
    }
    expect(manifest.build.filter(entry => entry.platforms?.includes("windows")).map(entry => entry.command)).toEqual([
      ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "scripts/preflight.ps1"],
      ["bun", "install"],
      ["bun", "run", "build"],
    ]);
  });
});
