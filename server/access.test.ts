import { describe, expect, it } from "bun:test";
import { cameThroughProxy, decideAccess, isLoopbackAddress, isLoopbackBind, isLoopbackHost, lanExposed, type AccessInput } from "./access.ts";

const device = { id: "d1", label: "Phone", role: "drive" as const };
const base: AccessInput = { loopback: true, forwarded: false, proxyHeaders: false, tokenMatched: false, device: null, tokenConfigured: false, gated: false };
const via = (input: Partial<AccessInput>) => { const a = decideAccess({ ...base, ...input }); return a.level === "full" ? a.via : `refused:${a.reason}`; };

describe("decideAccess", () => {
  it("requires credentials for forwarded loopback requests even before pairing", () => {
    expect(via({ forwarded: true })).toBe("refused:pairing_required");
    expect(via({ forwarded: true, tokenMatched: true })).toBe("token");
    expect(via({ forwarded: true, device })).toBe("device");
  });

  it("lets this PC in without a token, but not through a proxy", () => {
    expect(via({})).toBe("local");
    expect(via({ forwarded: true, gated: true })).toBe("refused:pairing_required");
  });

  it("keeps everything open, as before, while no token and no device exist", () => {
    expect(via({ loopback: false })).toBe("open");
    expect(via({ loopback: false, proxyHeaders: true })).toBe("refused:pairing_required");
    expect(via({ loopback: true, forwarded: true })).toBe("refused:pairing_required");
    expect(via({ loopback: false, gated: true })).toBe("refused:pairing_required");
  });

  it("a paired device gets in from anywhere, with its role", () => {
    const access = decideAccess({ ...base, loopback: false, gated: true, device: { ...device, role: "watch" } });
    expect(access).toEqual({ level: "full", via: "device", role: "watch", device: { ...device, role: "watch" } });
  });

  it("knows a name for this machine from a proxied Host", () => {
    for (const host of ["localhost", "localhost:7317", "LOCALHOST:5173", "herdr.localhost:7317", "127.0.0.1:7317", "127.9.9.9", "[::1]:7317", "localhost.:7317", "[::ffff:127.0.0.1]:7317"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["app.example.test", "app.example.test:8443", "192.168.0.10:7317", "localhost.example.test", "127.0.0.1.example.test", "[fd7a::1]:7317", "", "0.0.0.0:7317", "[::ffff:192.168.0.10]"]) expect(isLoopbackHost(host)).toBe(false);
    // not an authority: a URL parser would have read these as localhost
    for (const host of ["public.example@localhost:7317", "localhost/x@public.example", "localhost:7317/x", "localhost?x", "local host", "localhost:port", "localhost..", "127.0.0.1@public.example"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("sees a proxy in a forwarding header or in a Host that is not this machine", () => {
    const proxy = (headers: Record<string, string>) => cameThroughProxy(new Headers(headers));
    expect(proxy({ host: "localhost:7317" })).toBe(false);
    expect(proxy({ host: "127.0.0.1:7317", origin: "http://127.0.0.1:7317" })).toBe(false);
    // no Host at all: HTTP/1.0 through a proxy, never a local browser or CLI
    expect(proxy({})).toBe(true);
    expect(proxy({ host: "public.example@localhost:7317" })).toBe(true);
    expect(proxy({ host: "app.example.test" })).toBe(true);
    for (const name of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "tailscale-user-login", "tailscale-funnel-request"]) expect(proxy({ host: "127.0.0.1:7317", [name]: "x" })).toBe(true);
  });

  it("knows loopback addresses in every spelling", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
    for (const address of ["192.168.0.10", "100.64.0.2", "::ffff:192.168.0.10", "fd7a::1"]) expect(isLoopbackAddress(address)).toBe(false);
  });
});

describe("lanExposed", () => {
  const open = { hostname: "0.0.0.0", tokenConfigured: false, gated: false };
  const warned = (over: Partial<typeof open>): boolean => lanExposed({ ...open, ...over });

  it("names the one state a warning belongs to: bound past this PC, no token, nothing paired", () => {
    expect(lanExposed(open)).toBe(true);
    // wildcard, LAN, other IPv6 and DNS binds still warn, on any network
    for (const hostname of ["::", "[::]", "192.168.0.10", "fd7a::1", "my-pc.local", "127.devbox.example", "localhost.example", "100.63.255.255", "100.128.0.0", "fd7a:115c:a1df:ffff:ffff:ffff:ffff:ffff", "fd7a:115c:a1e1::", "100.64.0.999", "100.64.0.2.example"]) {
      expect(isLoopbackBind(hostname)).toBe(false);
      expect(warned({ hostname })).toBe(true);
    }
  });

  it("is quiet whenever one of the three is not the case", () => {
    // a loopback bind is unreachable from the network however it is addressed or spelt
    for (const hostname of ["127.0.0.1", "localhost", "::1", "127.0.0.2", "[::1]", "LOCALHOST", "::ffff:127.0.0.1", "app.localhost", " localhost "]) {
      expect(isLoopbackBind(hostname)).toBe(true);
      expect(warned({ hostname })).toBe(false);
    }
    // a token means a stranger is asked for it, and a paired device means the gate is closed
    expect(warned({ tokenConfigured: true })).toBe(false);
    expect(warned({ gated: true })).toBe(false);
    expect(warned({ tokenConfigured: true, gated: true })).toBe(false);
  });
});
