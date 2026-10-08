/**
 * Optional shared-token gate for herdr-web-ui.
 *
 * There is no user database here: the token is the whole authorization decision,
 * and whoever holds it can type into live terminals. Hence constant-time compares
 * (a length-leaking `===` is enough to guess a token over a LAN), an HttpOnly +
 * SameSite=Strict cookie so page JavaScript can never read it back, and a `Secure`
 * flag whenever the request arrived over TLS or through a TLS-terminating proxy.
 *
 * An empty token disables this gate; server/access.ts then decides by where a request comes
 * from, what Tailscale says about it, and whether it holds a paired device's cookie (the
 * helpers for that cookie live here too), and index.ts warns when a public bind address is
 * combined with neither.
 */

import { timingSafeEqual } from "node:crypto";

import { isLoopbackAddress } from "./access.ts";
import { badRequest, jsonResponse } from "./http.ts";

export const TOKEN_COOKIE = "herdr_web_token";
/** a paired device's own credential; the same flags as the token cookie */
export const DEVICE_COOKIE = "herdr_web_device";
const COOKIE_MAX_AGE_SECONDS = 31536000;

/**
 * Guessing budgets, per client address. A token is meant to be a long random string, but an
 * owner who picked a short one would otherwise be guessable without bound, so a run of wrong
 * tokens costs the address a wait that doubles with every further failure. The comparison
 * itself stays constant-time; this only makes it expensive to keep asking.
 *
 * There are two budgets per address: one for POST /api/auth (the sign-in form) and one for a
 * token presented with any other request (`Authorization: Bearer` or the token cookie). Every
 * page load and poll of a browser holding a stale cookie spends the second; keeping them apart
 * means that never stops its owner from signing in with the right token, and a right sign-in
 * spends both waits.
 */
const AUTH_FAILURE_BUDGET = 5;
const AUTH_BACKOFF_MS = 1_000;
const AUTH_BACKOFF_MAX_MS = 60_000;
/** addresses remembered; past the cap the ones whose wait is over are dropped first */
const AUTH_CLIENTS_MAX = 1024;
const authAttempts = new Map<string, { failures: number; until: number }>();
const BEARER_PREFIX = "bearer ";
const encoder = new TextEncoder();

/** Malformed pairs are skipped: a junk cookie from another app must not deny the user. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(pair.slice(separator + 1).trim()));
    } catch (error) {
      if (error instanceof URIError) continue;
      throw error;
    }
  }
  return cookies;
}

function matches(candidate: string, token: string): boolean {
  const left = encoder.encode(candidate);
  const right = encoder.encode(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAuthenticated(request: Request, token: string): boolean {
  if (token === "") return true;
  const cookie = parseCookies(request.headers.get("cookie")).get(TOKEN_COOKIE);
  if (cookie !== undefined && matches(cookie, token)) return true;
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  return matches(authorization.slice(BEARER_PREFIX.length), token);
}

/** /api/health, /api/auth and /api/devices/pair stay open so a client can discover the gate and pass it. */
export function requiresAuth(pathname: string): boolean {
  if (pathname === "/ws") return true;
  if (!pathname.startsWith("/api/")) return false;
  return pathname !== "/api/health" && pathname !== "/api/auth" && pathname !== "/api/devices/pair";
}

export function unauthorizedJson(reason: "other_user" | "pairing_required" | "token_required" = "token_required"): Response {
  if (reason === "other_user") return jsonResponse({ error: { code: "other_user", message: "this PC belongs to another Tailscale user" } }, 403);
  return jsonResponse({ error: { code: "unauthorized", message: reason === "pairing_required" ? "pair this device, or use the token" : "token required" } }, 401);
}

export function isSecureRequest(request: Request): boolean {
  if (request.headers.get("x-forwarded-proto") === "https") return true;
  return new URL(request.url).protocol === "https:";
}

function sessionCookie(token: string, secure: boolean): string {
  const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; ${attributes}${secure ? "; Secure" : ""}`;
}

export function deviceCookie(token: string, secure: boolean): string {
  return `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function noContent(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 204, headers });
}

/**
 * How long `client` still has to wait, in whole seconds, or 0. An address with no address
 * to remember (a unix socket, a proxy that hid it) is never held back: the budget is there
 * to make guessing expensive, not to lock anyone out.
 */
function authWaitLeft(client: string | null): number {
  if (client === null) return 0;
  const entry = authAttempts.get(client);
  const left = entry === undefined ? 0 : entry.until - Date.now();
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}

/**
 * The address a budget is kept for. A proxy on this PC (`tailscale serve`, a local reverse
 * proxy) is the peer of every request it forwards, so without this every visitor would share
 * the one 127.0.0.1 budget and five wrong tries from anyone would lock the owner out. Such a
 * proxy appends the address it saw to X-Forwarded-For, so the last entry is its word; earlier
 * entries are whatever the client sent. A peer that is not loopback is never taken on its word.
 */
export function authClient(peer: string | null, headers: Headers): string | null {
  if (peer === null || !isLoopbackAddress(peer)) return peer;
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return forwarded ? forwarded : peer;
}

const signInKey = (client: string | null): string | null => (client === null ? null : `sign-in ${client}`);
const presentedKey = (client: string | null): string | null => (client === null ? null : `presented ${client}`);

/**
 * What the token presented with a request (Bearer or cookie) says: nothing presented, the
 * right token, a wrong one, or `held` while the address is inside its wait, when it is not
 * compared at all, so a guess made during the wait learns nothing.
 */
export function presentedToken(request: Request, token: string, client: string | null): "none" | "match" | "wrong" | "held" {
  if (token === "") return "none";
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX;
  if (!bearer && !parseCookies(request.headers.get("cookie")).has(TOKEN_COOKIE)) return "none";
  if (authWaitLeft(presentedKey(client)) > 0) return "held";
  return isAuthenticated(request, token) ? "match" : "wrong";
}

/** Counts a wrong token presented with a request the server then refused. */
export function recordPresentedTokenFailure(client: string | null): void {
  recordAuthFailure(presentedKey(client));
}

/** The answer to a request whose Bearer token was not compared because its address is waiting. */
export function presentedTokenHeld(client: string | null): Response {
  return tooManyAttempts(authWaitLeft(presentedKey(client)));
}

function tooManyAttempts(wait: number): Response {
  return jsonResponse({ error: { code: "too_many_attempts", message: `too many wrong tokens: wait ${wait}s` } }, 429, { "retry-after": String(wait) });
}

function recordAuthFailure(client: string | null): void {
  if (client === null) return;
  const failures = (authAttempts.get(client)?.failures ?? 0) + 1;
  // the budget is spent first: the failures under it cost nothing but the answer they got
  const wait = failures < AUTH_FAILURE_BUDGET ? 0 : Math.min(AUTH_BACKOFF_MS * 2 ** (failures - AUTH_FAILURE_BUDGET), AUTH_BACKOFF_MAX_MS);
  authAttempts.set(client, { failures, until: wait === 0 ? 0 : Date.now() + wait });
  if (authAttempts.size <= AUTH_CLIENTS_MAX) return;
  // over the cap: an address whose wait is over first, else the oldest
  for (const [address, entry] of authAttempts) {
    if (authAttempts.size <= AUTH_CLIENTS_MAX / 2) return;
    if (entry.until !== 0 && entry.until > Date.now()) continue;
    authAttempts.delete(address);
  }
  while (authAttempts.size > AUTH_CLIENTS_MAX) authAttempts.delete(authAttempts.keys().next().value!);
}

/** Forget every address's budget (tests share this module's state). */
export function forgetAuthAttempts(): void {
  authAttempts.clear();
}

export async function handleAuthRequest(request: Request, token: string, client: string | null = null): Promise<Response> {
  if (request.method === "DELETE") {
    // signing out drops both credentials this browser may hold
    return noContent(`${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`, `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  }
  if (request.method !== "POST") return badRequest("method_not_allowed", "use POST or DELETE");
  // Gate off: answering 204 without a cookie lets one client flow work either way.
  if (token === "") return noContent();
  const wait = authWaitLeft(signInKey(client));
  if (wait > 0) return tooManyAttempts(wait);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (typeof payload !== "object" || payload === null || !("token" in payload)) {
    return badRequest("missing_token", "token is required");
  }
  const offered = payload.token;
  if (typeof offered !== "string") return badRequest("missing_token", "token is required");
  if (!matches(offered, token)) {
    recordAuthFailure(signInKey(client));
    return jsonResponse({ error: { code: "invalid_token", message: "token does not match" } }, 401);
  }
  // the right token, typed in: both waits are spent, a stale cookie's included
  for (const key of [signInKey(client), presentedKey(client)]) if (key !== null) authAttempts.delete(key);
  return noContent(sessionCookie(token, isSecureRequest(request)));
}
