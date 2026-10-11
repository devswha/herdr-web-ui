import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { atLeast, handlePortalRequest, PortalService, readyUrl, relayOrigin } from "./portal.ts";

/**
 * The service runs a stand-in portal here, a shell script, and asks a relay through an injected
 * fetch: no test reaches a real relay.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-portal-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADDRESS = "https://herdr-test-0123456789abcdef0123456789abcdef01234567.relay.example";
const RELAY = "https://relay.example";
const open = { tokenSet: true, serveOnly: false };

interface StandIn {
  path: string;
  /** the last `expose`'s arguments, one a line, then what it saw of the environment */
  seen: () => string[];
  /** the pid of every `expose` so far */
  pids: () => number[];
}

/** A portal whose `expose` prints `says`, then the ready line unless `ready` is false, and runs until stopped. */
function standIn(options: { version?: string; ready?: boolean; says?: string; ignoreTerm?: boolean; exitAfter?: boolean } = {}): StandIn {
  const dir = mkdtempSync(join(root, "bin-"));
  const path = join(dir, "portal");
  const seen = join(dir, "seen");
  const pids = join(dir, "pids");
  writeFileSync(path, [
    "#!/bin/sh",
    'case "$1" in',
    `  version) echo '${options.version ?? "v2.6.1"}' ;;`,
    "  expose)",
    `    echo $$ >> '${pids}'`,
    `    { printf '%s\\n' "$@"; echo "token=\${HERDR_WEB_TOKEN-unset} identity=\${IDENTITY_PATH-unset}"; } > '${seen}'`,
    options.ignoreTerm ? "    trap '' TERM" : "    trap 'exit 0' TERM",
    options.says ? `    echo '${options.says}' >&2` : "    :",
    options.ready === false ? "    :" : `    echo '2026-10-11T00:00:00Z INF service ready at ${ADDRESS}:443'`,
    options.exitAfter ? "    exit 3 ;;" : "    while :; do sleep 0.05; done ;;",
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return {
    path,
    seen: () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n") : [],
    pids: () => existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : [],
  };
}

/** A relay that answers its version the way Portal's /sdk/domain does. */
function relay(version = "v2.6.1"): typeof fetch {
  return (async (url: string | URL | Request) => {
    if (!String(url).endsWith("/sdk/domain")) return new Response(null, { status: 404 });
    return Response.json({ data: { protocol_version: "10", release_version: version } });
  }) as unknown as typeof fetch;
}

async function until(service: PortalService, done: (status: PortalStatus) => boolean, what: string): Promise<PortalStatus> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await service.status(open);
    if (done(status)) return status;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what} (phase ${status.phase}, error ${status.error})`);
    await Bun.sleep(20);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

// what a server started by the herdr plugin may carry: its own token, and Portal's own settings
const inherited = { HERDR_WEB_TOKEN: "do-not-pass-this-on", IDENTITY_PATH: "/somewhere/else.json" };
const previous: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(inherited)) { previous[name] = process.env[name]; process.env[name] = value; }
});
afterEach(() => {
  for (const name of Object.keys(inherited)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

describe("what Portal is given and says", () => {
  it("takes one relay as an https origin, a bare host included, and nothing else", () => {
    expect(relayOrigin("relay.example")).toBe(RELAY);
    expect(relayOrigin(" https://relay.example/ ")).toBe(RELAY);
    expect(relayOrigin("https://relay.example:8443")).toBe("https://relay.example:8443");
    // `--relays` reads a comma as a second relay
    for (const refused of ["", "http://relay.example", "https://user:pass@relay.example", "https://relay.example/path", "https://relay.example/?x=1", "relay.example --hide", "relay.example,evil.example", "https://a.example,b.example", 7, null]) {
      expect(relayOrigin(refused)).toBeNull();
    }
  });

  it("reads the address off the ready line, without the default port", () => {
    expect(readyUrl(`2026-10-11T00:00:00Z INF service ready at ${ADDRESS}:443`)).toBe(ADDRESS);
    expect(readyUrl("2026-10-11T00:00:00Z WRN relay operation failed")).toBeNull();
  });

  it("compares versions by number", () => {
    expect(atLeast("v2.6.1", "v2.6.1")).toBe(true);
    expect(atLeast("v2.10.0", "v2.6.1")).toBe(true);
    expect(atLeast("v2.6.0", "v2.6.1")).toBe(false);
    expect(atLeast("devel", "v2.6.1")).toBe(false);
  });
});

describe("running Portal", () => {
  it("opens nothing without a token, or while tailscale serve is declared the only way in", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    expect(service.start({ relay: RELAY, port: 7317, tokenSet: false, serveOnly: false })).toBe("token_required");
    expect(service.start({ relay: RELAY, port: 7317, tokenSet: true, serveOnly: true })).toBe("serve_only");
    expect((await service.status({ tokenSet: false, serveOnly: false })).blocked).toBe("token_required");
    expect(portal.pids()).toEqual([]);
  });

  it("exposes this server in routed mode on the one relay given, without a visitor's Tailscale login or this server's secrets", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    expect(service.start({ relay: RELAY, port: 7317, ...open })).toBe("started");
    const status = await until(service, (s) => s.phase !== "starting", "Portal was ready");
    expect(status).toMatchObject({ phase: "running", url: ADDRESS, relay: RELAY });
    const seen = portal.seen();
    const flag = (name: string) => seen[seen.indexOf(name) + 1];
    expect(seen[0]).toBe("expose");
    expect(flag("--http-route")).toBe("/=7317");
    expect(flag("--strip-request-header")).toBe("Tailscale-User-Login");
    expect(flag("--relays")).toBe(RELAY);
    expect(flag("--identity-path")).toBe(join(stateDir, "portal", "identity.json"));
    expect(seen).toContain("--discovery=false");
    expect(seen).toContain("--hide");
    expect(seen.at(-1)).toBe("token=unset identity=unset");

    service.stop();
    expect((await until(service, (s) => s.phase === "idle", "Portal stopped")).url).toBeNull();
    expect(alive(portal.pids()[0]!)).toBe(false);
    // stopped is remembered: the next server leaves it off
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await next.status(open)).toMatchObject({ phase: "idle", relay: RELAY });
    expect(portal.pids()).toHaveLength(1);
  });

  it("ends with its server, and comes back with the next one", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    await first.shutdown();
    expect(alive(portal.pids()[0]!)).toBe(false);
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await until(next, (s) => s.phase !== "starting", "the next Portal was ready")).toMatchObject({ phase: "running", url: ADDRESS });
    await next.shutdown();
  });

  it("takes over from a Portal a server killed outright left running", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    // no shutdown: two processes with one identity would take the address from each other
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await until(next, (s) => s.phase !== "starting", "the next Portal was ready")).toMatchObject({ phase: "running" });
    const [left, own] = portal.pids();
    expect(alive(left!)).toBe(false);
    expect(alive(own!)).toBe(true);
    await next.shutdown();
  });

  it("stops a Portal the last server left running even when it may not open the address itself", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    const tokenless = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await tokenless.resume({ port: 7317, tokenSet: false, serveOnly: false });
    expect(await gone(portal.pids()[0]!)).toBe(true);
    expect((await tokenless.status({ tokenSet: false, serveOnly: false })).phase).toBe("idle");
    expect(portal.pids()).toHaveLength(1);
  });

  it("leaves alone the Portal of a server on another port", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: RELAY, port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    const other = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await other.resume({ port: 7318, ...open });
    expect(alive(portal.pids()[0]!)).toBe(true);
    expect((await other.status(open)).phase).toBe("idle");
    await first.shutdown();
  });

  it("refuses a relay older than the tunnel needs before anything runs", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay("v2.6.0") });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("v2.6.1");
    expect(portal.pids()).toEqual([]);
  });

  it("offers no start without a portal recent enough, and says which", async () => {
    const old = standIn({ version: "v2.5.1" });
    const outdated = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: old.path, fetch: relay() });
    expect(await outdated.status(open)).toMatchObject({ version: "v2.5.1", usable: false });
    outdated.start({ relay: RELAY, port: 7317, ...open });
    expect((await until(outdated, (s) => s.phase !== "starting", "the start ended")).error).toContain("v2.5.1");
    expect(old.pids()).toEqual([]);

    const missing = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: join(root, "no-such-portal"), fetch: relay() });
    expect(await missing.status(open)).toMatchObject({ supported: true, version: null, usable: false });
  });

  it("gives up on a relay that never takes the tunnel, and says what Portal said", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z WRN lease registration failed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), readyTimeoutMs: 300 });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start gave up");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("lease registration failed");
    expect(await gone(portal.pids()[0]!)).toBe(true);
  });

  it("stops a Portal a relay refused for good", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z ERR relay operation failed permanently error=\"name taken\"" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("name taken");
  });

  it("tells of a Portal that ended on its own, in its last words", async () => {
    const portal = standIn({ exitAfter: true, says: "2026-10-11T00:00:00Z ERR listener closed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.start({ relay: RELAY, port: 7317, ...open });
    const status = await until(service, (s) => s.phase === "error", "Portal ended");
    expect(status.error).toContain("exit 3");
    expect(status.error).toContain("listener closed");
    expect(status.url).toBeNull();
  });

  it("kills a Portal that does not stop when asked", async () => {
    const portal = standIn({ ignoreTerm: true });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), stopGraceMs: 200 });
    service.start({ relay: RELAY, port: 7317, ...open });
    await until(service, (s) => s.phase === "running", "Portal was ready");
    service.stop();
    await until(service, (s) => s.phase === "idle", "Portal was killed");
    expect(alive(portal.pids()[0]!)).toBe(false);
  });
});

describe("the Portal endpoint", () => {
  const url = "http://127.0.0.1:7317/api/portal";
  const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const server = { port: 7317, ...open };
  const post = (action: string, body: unknown = { relay: "relay.example" }, headers: Record<string, string> = own) =>
    new Request(`${url}/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
  const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

  it("answers the status without caching, and offers nothing without the service", async () => {
    const response = await handlePortalRequest(new Request(url), "/api/portal", undefined, server);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ supported: false });
    expect(await code(await handlePortalRequest(post("stop"), "/api/portal/stop", undefined, server))).toBe("portal_unsupported");
  });

  it("starts and stops Portal only for this app's own controls, and starts it only with a token", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    for (const headers of [{ ...own, "x-herdr-update": "0" }, { ...own, origin: "https://evil.example" }, { ...own, "sec-fetch-site": "cross-site" }]) {
      expect(await code(await handlePortalRequest(post("start", undefined, headers), "/api/portal/start", service, server))).toBe("invalid_portal_request");
    }
    for (const relayInput of ["http://relay.example", "relay.example,evil.example"]) {
      expect(await code(await handlePortalRequest(post("start", { relay: relayInput }), "/api/portal/start", service, server))).toBe("invalid_relay");
    }
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...server, tokenSet: false }))).toBe("token_required");
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...server, serveOnly: true }))).toBe("serve_only");
    expect(portal.pids()).toEqual([]);

    expect((await handlePortalRequest(post("start"), "/api/portal/start", service, server)).status).toBe(202);
    expect(await until(service, (s) => s.phase !== "starting", "Portal was ready")).toMatchObject({ phase: "running", relay: RELAY });
    expect((await handlePortalRequest(post("stop", {}), "/api/portal/stop", service, server)).status).toBe(202);
    await until(service, (s) => s.phase === "idle", "Portal stopped");
    expect((await handlePortalRequest(new Request(url, { method: "DELETE" }), "/api/portal", service, server)).status).toBe(405);
    expect((await handlePortalRequest(post("install"), "/api/portal/install", service, server)).status).toBe(405);
  });
});
