import type { AccessRefusal, AccessVia, DeviceRole } from "../shared/protocol.ts";
import type { DeviceMatch } from "./devices.ts";

export interface AccessInput {
  loopback: boolean;
  forwarded: boolean;
  /** Explicit forwarding/identity headers, regardless of the peer address. */
  proxyHeaders: boolean;
  tokenMatched: boolean;
  device: DeviceMatch | null;
  tokenConfigured: boolean;
  gated: boolean;
}

export type Access =
  | { level: "full"; via: AccessVia; role: DeviceRole; device?: DeviceMatch }
  | { level: "none"; reason: AccessRefusal };

export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/**
 * Is this bind address one only this machine can reach, so an unset token is nobody else's
 * business? Any spelling of loopback counts: `127.0.0.2`, `[::1]`, `LOCALHOST`, `::ffff:127.0.0.1`.
 * A name that merely resolves to loopback is not recognised; the bind address is what Bun was
 * given, not what DNS says of it.
 */
export function isLoopbackBind(hostname: string): boolean {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  // the address tests apply to an address: a DNS name such as 127.devbox.example may point anywhere
  const literal = /^[\d.]+$/.test(name) || name.includes(":");
  return name === "localhost" || name.endsWith(".localhost") || (literal && isLoopbackAddress(name));
}

/** Warn whenever an unauthenticated bind is reachable beyond loopback. */
export function lanExposed(input: { hostname: string; tokenConfigured: boolean; gated: boolean }): boolean {
  return !isLoopbackBind(input.hostname) && !input.tokenConfigured && !input.gated;
}

/** Identity headers confer no trust: they mark a proxy just like forwarding headers. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "tailscale-user-login", "tailscale-funnel-request"];

/**
 * The name a Host header addresses, lower-cased, without its port or its DNS root dot. It is read
 * as a bare authority, a name or a bracketed address with an optional port, and nothing else:
 * handed to a URL parser, `public.example@localhost` and `localhost/x@public.example` both came
 * out as localhost.
 */
export function hostName(host: string): string | null {
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host);
  // one trailing dot is the DNS root, the same name
  return authority ? authority[1]!.toLowerCase().replace(/\.$/, "") : null;
}

/** Is this Host header a name for this machine itself? */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name !== null && (name === "localhost" || name.endsWith(".localhost") || name === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(name) || /^\[::ffff:127(?:\.\d{1,3}){3}\]$/.test(name));
}

/**
 * Evidence that a request reached this server through a proxy. Claiming it only ever costs the
 * sender the trust a local connection has, so a forged header gains nothing.
 */
export function hasProxyHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => headers.has(name));
}

export function cameThroughProxy(headers: Headers): boolean {
  if (hasProxyHeaders(headers)) return true;
  // no Host at all is not how a browser or a CLI on this PC asks (HTTP/1.0 through a proxy is)
  const host = headers.get("host");
  return host === null || !isLoopbackHost(host);
}

export function decideAccess(input: AccessInput): Access {
  if (input.tokenMatched) return { level: "full", via: "token", role: "drive" };
  if (input.device !== null) return { level: "full", via: "device", role: input.device.role, device: input.device };
  // A configured token gates even direct local clients.
  if (input.tokenConfigured) return { level: "none", reason: "token_required" };
  // A loopback proxy is not a local browser. Credentials are required even before pairing.
  if (input.proxyHeaders || (input.loopback && input.forwarded)) return { level: "none", reason: "pairing_required" };
  if (input.loopback) return { level: "full", via: "local", role: "drive" };
  if (!input.gated) return { level: "full", via: "open", role: "drive" };
  return { level: "none", reason: "pairing_required" };
}
