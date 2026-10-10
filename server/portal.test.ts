import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { atLeast, handlePortalRequest, PortalService, readyUrl, relayOrigin } from "./portal.ts";

/**
 * The service runs a stand-in portal here, a shell script, and asks a relay through an injected
 * fetch: no test reaches a real relay or downloads a release.
 */
const root = mkdtempSync(join(tmpdir(), "herdr-portal-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADDRESS = "https://herdr-test-0123456789abcdef0123456789abcdef01234567.relay.example";
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

async function until(service: PortalService, done: (status: Omit<PortalStatus, "here">) => boolean, what: string): Promise<Omit<PortalStatus, "here">> {
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

// what a server started by the herdr plugin may carry: its own token, and Portal's own settings
const inherited = { HERDR_WEB_TOKEN: "do-not-pass-this-on", IDENTITY_PATH: "/somewhere/else.json", HERDR_WEB_PORTAL_BIN: undefined };
const previous: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [name, value] of Object.entries(inherited)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterEach(() => {
  for (const name of Object.keys(inherited)) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

describe("what Portal is given and says", () => {
  it("takes a relay as an https origin, a bare host included, and nothing else", () => {
    expect(relayOrigin("relay.example")).toBe("https://relay.example");
    expect(relayOrigin(" https://relay.example/ ")).toBe("https://relay.example");
    expect(relayOrigin("https://relay.example:8443")).toBe("https://relay.example:8443");
    for (const refused of ["", "http://relay.example", "https://user:pass@relay.example", "https://relay.example/path", "https://relay.example/?x=1", "relay.example --hide", 7, null]) {
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

describe("installing Portal", () => {
  const binary = "#!/bin/sh\necho v2.6.1\n";
  const digest = createHash("sha256").update(binary).digest("hex");
  const serve = (async () => new Response(binary)) as unknown as typeof fetch;

  it("puts the release on this PC once its digest matches the pinned one", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const service = new PortalService({ stateDir, release: { url: "https://releases.example/portal", sha256: digest }, fetch: serve });
    expect(service.install()).toBe("started");
    expect(service.install()).toBe("busy");
    const status = await until(service, (s) => s.phase !== "installing", "the install ended");
    expect(status).toMatchObject({ phase: "idle", version: "v2.6.1", usable: true, error: null });
    expect(statSync(join(stateDir, "portal", "bin", "portal")).mode & 0o777).toBe(0o755);
  });

  it("installs nothing from a download that does not match", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const service = new PortalService({ stateDir, release: { url: "https://releases.example/portal", sha256: "0".repeat(64) }, fetch: serve });
    expect(service.install()).toBe("started");
    const status = await until(service, (s) => s.phase !== "installing", "the install ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("does not match");
    expect(readdirSync(join(stateDir, "portal", "bin"))).toEqual([]);
  });

  it("offers no install where Portal has no release", () => {
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), platform: "plan9-mips" });
    expect(service.install()).toBe("unsupported");
  });
});

describe("running Portal", () => {
  it("opens nothing without a token, or while tailscale serve is declared the only way in", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    expect(service.start({ relay: "https://relay.example", port: 7317, tokenSet: false, serveOnly: false })).toBe("token_required");
    expect(service.start({ relay: "https://relay.example", port: 7317, tokenSet: true, serveOnly: true })).toBe("serve_only");
    expect((await service.status({ tokenSet: false, serveOnly: false })).blocked).toBe("token_required");
    expect(portal.pids()).toEqual([]);
  });

  it("exposes this server in routed mode on the one relay given, without a visitor's Tailscale login or this server's secrets", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const service = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    expect(service.start({ relay: "https://relay.example", port: 7317, ...open })).toBe("started");
    const status = await until(service, (s) => s.phase !== "starting", "Portal was ready");
    expect(status).toMatchObject({ phase: "running", url: ADDRESS, relay: "https://relay.example" });
    const seen = portal.seen();
    const flag = (name: string) => seen[seen.indexOf(name) + 1];
    expect(seen[0]).toBe("expose");
    expect(flag("--http-route")).toBe("/=7317");
    expect(flag("--strip-request-header")).toBe("Tailscale-User-Login");
    expect(flag("--relays")).toBe("https://relay.example");
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
    expect(await next.status(open)).toMatchObject({ phase: "idle", relay: "https://relay.example" });
    expect(portal.pids()).toHaveLength(1);
  });

  it("comes back with the next server, and takes over from a Portal the last one left running", async () => {
    const stateDir = mkdtempSync(join(root, "state-"));
    const portal = standIn();
    const first = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    first.start({ relay: "https://relay.example", port: 7317, ...open });
    await until(first, (s) => s.phase === "running", "the first Portal was ready");
    // a server killed outright stops nothing: its Portal keeps the identity
    const next = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await next.resume({ port: 7317, ...open });
    expect(await until(next, (s) => s.phase !== "starting", "the next Portal was ready")).toMatchObject({ phase: "running", url: ADDRESS });
    const [left, own] = portal.pids();
    expect(alive(left!)).toBe(false);
    expect(alive(own!)).toBe(true);
    // a server that cannot open the address leaves the saved choice alone and starts nothing
    next.shutdown();
    await until(next, (s) => s.phase === "idle", "the Portal ended with its server");
    const unguarded = new PortalService({ stateDir, bin: portal.path, fetch: relay() });
    await unguarded.resume({ port: 7317, tokenSet: false, serveOnly: false });
    expect((await unguarded.status(open)).phase).toBe("idle");
    expect(portal.pids()).toHaveLength(2);
  });

  it("refuses a relay older than the tunnel needs before anything runs", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay("v2.6.0") });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("v2.6.1");
    expect(portal.pids()).toEqual([]);
  });

  it("refuses a Portal older than the tunnel needs", async () => {
    const portal = standIn({ version: "v2.5.1" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    expect(await service.status(open)).toMatchObject({ version: "v2.5.1", usable: false });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    expect((await until(service, (s) => s.phase !== "starting", "the start ended")).phase).toBe("error");
    expect(portal.pids()).toEqual([]);
  });

  it("gives up on a relay that never takes the tunnel, and says what Portal said", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z WRN lease registration failed" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), readyTimeoutMs: 300 });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start gave up");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("lease registration failed");
    const deadline = Date.now() + 5_000;
    while (alive(portal.pids()[0]!) && Date.now() < deadline) await Bun.sleep(20);
    expect(alive(portal.pids()[0]!)).toBe(false);
  });

  it("stops a Portal a relay refused for good", async () => {
    const portal = standIn({ ready: false, says: "2026-10-11T00:00:00Z ERR relay operation failed permanently error=\"name taken\"" });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    const status = await until(service, (s) => s.phase !== "starting", "the start ended");
    expect(status.phase).toBe("error");
    expect(status.error).toContain("name taken");
  });

  it("tells of a Portal that ended on its own", async () => {
    const portal = standIn({ exitAfter: true });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    const status = await until(service, (s) => s.phase === "error", "Portal ended");
    expect(status.error).toContain("exit 3");
    expect(status.url).toBeNull();
  });

  it("kills a Portal that does not stop when asked", async () => {
    const portal = standIn({ ignoreTerm: true });
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay(), stopGraceMs: 200 });
    service.start({ relay: "https://relay.example", port: 7317, ...open });
    await until(service, (s) => s.phase === "running", "Portal was ready");
    service.stop();
    await until(service, (s) => s.phase === "idle", "Portal was killed");
    expect(alive(portal.pids()[0]!)).toBe(false);
  });
});

describe("the Portal endpoint", () => {
  const url = "http://127.0.0.1:7317/api/portal";
  const own = { "x-herdr-update": "1", origin: "http://127.0.0.1:7317", "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const here = { here: true, port: 7317, ...open };
  const post = (action: string, body: unknown = { relay: "relay.example" }, headers: Record<string, string> = own) =>
    new Request(`${url}/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
  const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

  it("answers the status without caching, and offers nothing without the service", async () => {
    const response = await handlePortalRequest(new Request(url), "/api/portal", undefined, { ...here, here: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ supported: false, here: false });
    expect(await code(await handlePortalRequest(post("stop"), "/api/portal/stop", undefined, here))).toBe("portal_unsupported");
  });

  it("starts Portal only for this app's own controls, on this PC itself, with a token", async () => {
    const portal = standIn();
    const service = new PortalService({ stateDir: mkdtempSync(join(root, "state-")), bin: portal.path, fetch: relay() });
    for (const headers of [{ ...own, "x-herdr-update": "0" }, { ...own, origin: "https://evil.example" }, { ...own, "sec-fetch-site": "cross-site" }]) {
      expect(await code(await handlePortalRequest(post("start", undefined, headers), "/api/portal/start", service, here))).toBe("invalid_portal_request");
    }
    for (const action of ["install", "start"]) {
      const refused = await handlePortalRequest(post(action), `/api/portal/${action}`, service, { ...here, here: false });
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("portal_not_here");
    }
    expect(await code(await handlePortalRequest(post("start", { relay: "http://relay.example" }), "/api/portal/start", service, here))).toBe("invalid_relay");
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...here, tokenSet: false }))).toBe("token_required");
    expect(await code(await handlePortalRequest(post("start"), "/api/portal/start", service, { ...here, serveOnly: true }))).toBe("serve_only");
    expect(portal.pids()).toEqual([]);

    expect((await handlePortalRequest(post("start"), "/api/portal/start", service, here)).status).toBe(202);
    expect(await until(service, (s) => s.phase !== "starting", "Portal was ready")).toMatchObject({ phase: "running", relay: "https://relay.example" });
    // any signed-in client may take the address down
    expect((await handlePortalRequest(post("stop", {}), "/api/portal/stop", service, { ...here, here: false })).status).toBe(202);
    await until(service, (s) => s.phase === "idle", "Portal stopped");
    expect((await handlePortalRequest(new Request(url, { method: "DELETE" }), "/api/portal", service, here)).status).toBe(405);
    expect((await handlePortalRequest(post("expose"), "/api/portal/expose", service, here)).status).toBe(405);
  });
});
