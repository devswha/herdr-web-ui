/** What the page knows about its own address. */
export interface PageLocation {
  protocol: string;
  hostname: string;
  origin: string;
  /** window.isSecureContext */
  secure: boolean;
}

/** A reachable HTTPS address, or guidance for a separately configured secure route. */
export type PhonePlan = { kind: "here"; url: string } | { kind: "unknown" };

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.startsWith("127.") || hostname === "[::1]" || hostname === "::1";
}

export function phonePlan(page: PageLocation): PhonePlan {
  if (page.protocol === "https:" && page.secure && !isLoopbackHost(page.hostname)) return { kind: "here", url: page.origin };
  return { kind: "unknown" };
}

/** A name for this device to pair under, from its user agent: "iPhone · Safari", "Windows · Chrome". */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent;
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|Chromium\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  return browser ? `${device} · ${browser}` : device;
}

/** The `?pair=CODE` a QR code carries, taken off the address at once so it stays out of history and referrers. */
export function takePairCode(): string {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const code = url.searchParams.get("pair") ?? "";
  if (code !== "") {
    url.searchParams.delete("pair");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }
  return code.replace(/\D/g, "").slice(0, 6);
}
