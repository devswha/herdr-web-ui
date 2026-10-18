import { DEVICE_COOKIE, parseCookies, TOKEN_COOKIE } from "./auth.ts";

export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  if (!origin) {
    // No Origin at all. A browser leaves it off its own same-origin GET and HEAD (the PC
    // event stream, an EventSource, can send no header of its own), so a read keeps passing.
    // A browser always attaches one to a state-changing request, so a session or device
    // cookie arriving on one without it is a header that went missing or a non-browser
    // client, not a same-origin page: it is read as cross-site.
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const cookies = parseCookies(request.headers.get("cookie"));
    if (!cookies.has(TOKEN_COOKIE) && !cookies.has(DEVICE_COOKIE)) return true; // CLI clients
    if (request.headers.get("x-herdr-request") === "1") return true;
    const { pathname } = new URL(request.url);
    return pathname === "/api/auth";
  }
  try {
    const expected = new URL(request.url);
    // Reverse proxies commonly terminate HTTPS; do not trust arbitrary forwarded hosts.
    // Traefik uses "wss" for a secure WebSocket upgrade, whose browser Origin is still https.
    const proto = request.headers.get("x-forwarded-proto");
    const websocket = request.method === "GET" && expected.pathname === "/ws"
      && request.headers.get("upgrade")?.toLowerCase() === "websocket"
      && request.headers.get("connection")?.split(",").some((part) => part.trim().toLowerCase() === "upgrade");
    if (proto === "https" || (proto === "wss" && websocket)) expected.protocol = "https:";
    return new URL(origin).origin === expected.origin;
  } catch { return false; }
}
