import { describe, expect, it } from "bun:test";
import { parseSoleTailnetLogin, parseTailscale, parseTailscaleIp } from "./tailscale.ts";

const status = (state = "Running", dns = "pc.example.ts.net.") => JSON.stringify({ BackendState: state, Self: { DNSName: dns } });
/** a `tailscale serve status --json` document: listeners by port, and one "/" proxy per host:port */
const serve = (tcp: Record<string, { HTTPS?: boolean; HTTP?: boolean }>, web: Record<string, string>) =>
  JSON.stringify({ TCP: tcp, Web: Object.fromEntries(Object.entries(web).map(([key, proxy]) => [key, { Handlers: { "/": { Proxy: proxy } } }])) });

/** a `tailscale status --json` document: this PC, then one peer per `[userId, tags]`, as the real one is shaped; `User` names each login by id */
const tailnet = (self: [number, string[] | undefined], peers: [number, string[] | undefined][] = [], state = "Running") => JSON.stringify({
  BackendState: state,
  Self: { DNSName: "pc.example.ts.net.", UserID: self[0], ...(self[1] ? { Tags: self[1] } : {}) },
  Peer: Object.fromEntries(peers.map(([userId, tags], index) => [`key${index}`, { DNSName: `peer${index}.example.ts.net.`, UserID: userId, ...(tags ? { Tags: tags } : {}) }])),
  User: Object.fromEntries([self[0], ...peers.map(([userId]) => userId)].map((userId) => [String(userId), { LoginName: `user${userId}@example.com` }])),
});

describe("parseSoleTailnetLogin", () => {
  it("names the login a tailnet one login owns, phones and offline peers included", () => {
    // the shape of the reported tailnet: this Mac plus six of the owner's own untagged devices
    expect(parseSoleTailnetLogin(tailnet([7511875822626835, undefined], Array.from({ length: 6 }, () => [7511875822626835, undefined] as [number, undefined])))).toBe("user7511875822626835@example.com");
    expect(parseSoleTailnetLogin(tailnet([42, undefined]))).toBe("user42@example.com");
  });

  it("names no login where a second login or any tag exists", () => {
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [[42, undefined], [43, undefined]]))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [[42, undefined], [42, ["tag:ci"]]]))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, ["tag:server"]], [[42, undefined]]))).toBeNull();
    // a peer the status names no owner for is not proof of anything
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running", Self: { UserID: 42 }, Peer: { k: { DNSName: "p.example.ts.net." } } }))).toBeNull();
  });

  it("names no login the status does not state, nor from a status it could not read, or a daemon that is not running", () => {
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running", Self: { UserID: 42 } }))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [], "Stopped"))).toBeNull();
    expect(parseSoleTailnetLogin(tailnet([42, undefined], [], "NeedsLogin"))).toBeNull();
    expect(parseSoleTailnetLogin(JSON.stringify({ BackendState: "Running" }))).toBeNull();
    expect(parseSoleTailnetLogin("not json")).toBeNull();
    expect(parseSoleTailnetLogin(null)).toBeNull();
  });
});

describe("parseTailscaleIp", () => {
  it("picks this PC's IPv4 tailnet address, and nothing when there is none", () => {
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1", "100.64.0.7"] } }))).toBe("100.64.0.7");
    expect(parseTailscaleIp(JSON.stringify({ Self: { TailscaleIPs: ["fd7a:115c:a1e0::1"] } }))).toBeNull();
    expect(parseTailscaleIp(JSON.stringify({ Self: {} }))).toBeNull();
    expect(parseTailscaleIp("not json")).toBeNull();
    expect(parseTailscaleIp(null)).toBeNull();
  });
});

describe("parseTailscale", () => {
  it("reports a PC without the CLI", () => {
    expect(parseTailscale(null, 7317)).toEqual({ state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null });
  });

  it("reports a daemon that did not answer, or is not connected", () => {
    for (const output of [{ status: null, serve: null }, { status: "not json", serve: null }, { status: status("NeedsLogin"), serve: null }, { status: status("Stopped"), serve: serve({}, {}) }]) {
      expect(parseTailscale(output, 7317).state).toBe("stopped");
      expect(parseTailscale(output, 7317).serve_command).toBeNull();
    }
  });

  it("finds the HTTPS listener that already proxies this server, and strips the DNS dot", () => {
    const output = { status: status(), serve: serve(
      { "443": { HTTPS: true }, "17317": { HTTPS: true } },
      { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:17317": "http://127.0.0.1:7317" },
    ) };
    expect(parseTailscale(output, 7317)).toEqual({ state: "running", dns_name: "pc.example.ts.net", serving_url: "https://pc.example.ts.net:17317", serve_command: null, serve_url: null });
  });

  it("names no port for 443, and accepts localhost as this machine", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://localhost:7317/" }) };
    expect(parseTailscale(output, 7317).serving_url).toBe("https://pc.example.ts.net");
  });

  it("suggests 443 when nothing is served, even when serve status failed", () => {
    for (const serveOutput of [null, serve({}, {})]) {
      expect(parseTailscale({ status: status(), serve: serveOutput }, 7317)).toEqual({
        state: "running", dns_name: "pc.example.ts.net", serving_url: null,
        serve_command: "tailscale serve --bg --https=443 http://127.0.0.1:7317", serve_url: "https://pc.example.ts.net",
      });
    }
  });

  it("skips the ports other services already use", () => {
    const output = { status: status(), serve: serve({ "443": { HTTPS: true }, "8443": { HTTPS: true } }, { "pc.example.ts.net:443": "http://127.0.0.1:8787", "pc.example.ts.net:8443": "http://127.0.0.1:3019/status" }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=7317 http://127.0.0.1:7317");
    expect(access.serve_url).toBe("https://pc.example.ts.net:7317");
  });

  it("does not count an HTTP listener, another path or another port as serving this server", () => {
    const output = { status: status(), serve: JSON.stringify({
      TCP: { "80": { HTTP: true }, "8443": { HTTPS: true }, "9000": { HTTPS: true } },
      Web: {
        "pc.example.ts.net:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:8443": { Handlers: { "/ui": { Proxy: "http://127.0.0.1:7317" } } },
        "pc.example.ts.net:9000": { Handlers: { "/": { Proxy: "http://127.0.0.1:7318" } } },
      },
    }) };
    const access = parseTailscale(output, 7317);
    expect(access.serving_url).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
  });

  it("gives a command but no address when MagicDNS reports no name", () => {
    const access = parseTailscale({ status: status("Running", ""), serve: null }, 7317);
    expect(access.dns_name).toBeNull();
    expect(access.serve_command).toBe("tailscale serve --bg --https=443 http://127.0.0.1:7317");
    expect(access.serve_url).toBeNull();
  });
});
