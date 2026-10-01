import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const windows = process.platform === "win32";
// macOS's per-user TMPDIR is long enough to push herdr's socket names past the 104-byte sun_path limit
const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "herdr-bundle-smoke-")));
const bundle = join(root, "runtime");
const home = join(root, "home");
// herdr follows XDG_CONFIG_HOME; a value apart from ~/.config proves the bridge follows it too.
// On Windows it follows APPDATA instead, and the bundle carries no herdr: the one herdr's own
// installer left (the stable alias under %LOCALAPPDATA%), or HERDR_WEB_HERDR_BIN.
const xdg = join(home, "xdg");
mkdirSync(bundle); mkdirSync(home);
const bun = join(bundle, windows ? "bin/bun.exe" : "bin/bun");
const herdr = windows ? process.env["HERDR_WEB_HERDR_BIN"] || join(process.env["LOCALAPPDATA"] ?? "", "Programs/Herdr/bin/herdr.exe") : join(bundle, "bin/herdr");
if (windows) assert.ok(existsSync(herdr), `herdr is not installed at ${herdr}`);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: xdg, XDG_CONFIG_HOME: xdg, HERDR_REMOTE_SESSION: "smoke", HERDR_WEB_HERDR_BIN: herdr };
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const archive = resolve(`remote-bundles/herdr-web-ui-${process.platform}-${process.arch}.tgz`);
  assert.equal(Bun.spawnSync(["tar", "xzf", archive, "-C", bundle]).exitCode, 0);
  child = Bun.spawn([bun, join(bundle, "server/remote-entry.ts")], { env, stdout: "inherit", stderr: "inherit" });
  const { createHash } = await import("node:crypto");
  const socket = join(xdg, "herdr/sessions/smoke/herdr.sock");
  const path = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(socket).digest("hex") + ".json");
  let descriptor: { port: number; token: string } | undefined;
  for (let i = 0; i < 400; i++) { try { descriptor = JSON.parse(readFileSync(path, "utf8")); break; } catch { await Bun.sleep(100); } }
  if (!descriptor) {
    for (const log of [join(home, ".config/herdr-web-ui/bridges/herdr.log"), join(xdg, "herdr/sessions/smoke/herdr-server.log")]) {
      console.error(`--- ${log}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-4000) : "(missing)"}`);
    }
  }
  assert.ok(descriptor, "bundle starts a private daemon and bridge without system runtimes");
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/bridge`, { headers: { authorization: `Bearer ${descriptor.token}` } });
  assert.equal(response.status, 200);
  const identity = await response.json() as { socket_path: string; herdr: { terminal_attach?: boolean } };
  assert.equal(identity.socket_path, socket);
  // a Windows herdr has no terminal attach (herdrdev/herdr#4821); the bridge must say so
  assert.equal(identity.herdr.terminal_attach, !windows);
  assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/api/session`)).status, 401);
  console.log("Remote bundle startup, isolated socket and authentication passed");
} finally {
  child?.kill(); if (child) await child.exited;
  Bun.spawnSync([herdr, "--session", "smoke", "server", "stop"], { env });
  // Windows keeps the directory busy for a moment after the daemon lets go of its files
  for (let i = 0; ; i++) {
    try { rmSync(root, { recursive: true, force: true }); break; } catch (error) {
      // a throw here would replace the assertion that failed above with a cleanup error
      if (i === 20) { console.error(`could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`); break; }
      await Bun.sleep(500);
    }
  }
}
