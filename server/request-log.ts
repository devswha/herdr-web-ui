import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorResponse, requestIdContext } from "./http.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

const FILE_BYTES = 1024 * 1024;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const ROUTES = new Set([
  "/ws", "/api/bridge", "/api/health", "/api/access", "/api/auth",
  "/api/devices", "/api/devices/pair", "/api/devices/pair/start",
  "/api/updates", "/api/updates/check", "/api/updates/install",
  "/api/updates/notes", "/api/updates/installed", "/api/herdr/update",
  "/api/portal", "/api/portal/start", "/api/portal/stop",
  "/api/connection-diagnostics", "/api/telemetry", "/api/preferences", "/api/seen",
  "/api/usage", "/api/usage/login", "/api/voice", "/api/voice/config",
  "/api/push", "/api/push/subscribe", "/api/push/test",
  "/api/machines", "/api/machines/events", "/api/machines/setup", "/api/machines/settings",
]);

export const clientRequestId = (value: string | null): string | undefined => value !== null && CLIENT_ID.test(value) ? value : undefined;
export const requestMethod = (value: string): string => METHODS.has(value) ? value : "OTHER";

/** Finite route names only: no URL, query, filename, label or opaque credential can escape. */
export function requestRoute(pathname: string): string {
  if (ROUTES.has(pathname)) return pathname;
  if (pathname.startsWith("/api/") && MACHINE_PROXY_PATH.test(pathname.slice(5))) return pathname;
  if (/^\/api\/devices\/[^/]+$/.test(pathname)) return "/api/devices/:device_id";
  if (/^\/api\/fs\/page-media\//.test(pathname)) return "/api/fs/page-media/:media_id";
  if (pathname.startsWith("/api/cliproxy/") || pathname === "/api/cliproxy") return "/api/cliproxy/:route";
  const machine = /^\/api\/machines\/[^/]+(?:\/(.*))?$/.exec(pathname);
  if (machine) {
    const route = machine[1];
    if (route === undefined) return "/api/machines/:machine_id";
    if (route === "update-bridge") return "/api/machines/:machine_id/update-bridge";
    if (MACHINE_PROXY_PATH.test(route)) return `/api/machines/:machine_id/${route}`;
  }
  if (/^\/api\/machines\/setup\/[^/]+$/.test(pathname)) return "/api/machines/setup/:job_id";
  return pathname.startsWith("/api/") ? "unmatched" : "static";
}

/** One synchronous, bounded writer per server; no queue, timer or streaming-body reader. */
export class RequestLog {
  private fd: number | undefined;
  private bytes = 0;
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "http-requests.jsonl");
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      chmodSync(stateDir, 0o700);
      this.open();
    } catch {
      // Completion telemetry is best effort, including unavailable or read-only state.
      this.close();
    }
  }

  private open(): void {
    this.fd = openSync(this.path, "a", 0o600);
    chmodSync(this.path, 0o600);
    this.bytes = fstatSync(this.fd).size;
  }

  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Best-effort telemetry must not break a response or shutdown. */ }
    }
  }

  async handle(request: Request, dispatch: (headers: Headers) => Promise<Response | undefined>): Promise<Response | undefined> {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const clientId = clientRequestId(request.headers.get("x-request-id"));
    const headers = new Headers({
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    return requestIdContext.run(requestId, async () => {
      let response: Response | undefined;
      try {
        response = await dispatch(headers);
      } catch (error) {
        response = errorResponse(error);
      }
      if (response !== undefined) {
        // Only correlation is authoritative. Route-authored security and cache headers win.
        response.headers.set("x-request-id", requestId);
        for (const name of ["x-content-type-options", "referrer-policy"]) {
          const value = headers.get(name);
          if (!response.headers.has(name) && value !== null) response.headers.set(name, value);
        }
      }
      const line = JSON.stringify({
        request_id: requestId,
        ...(clientId === undefined ? {} : { client_request_id: clientId }),
        method: requestMethod(request.method),
        route: requestRoute(new URL(request.url).pathname),
        status: response?.status ?? 101,
        latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
      }) + "\n";
      try {
        if (this.fd !== undefined && Buffer.byteLength(line) <= 1024) {
          if (this.bytes + Buffer.byteLength(line) > FILE_BYTES) {
            this.close();
            renameSync(this.path, `${this.path}.1`);
            this.open();
          }
          if (this.fd !== undefined) {
            const bytes = Buffer.from(line);
            let written = 0;
            while (written < bytes.length) written += writeSync(this.fd, bytes, written);
            this.bytes += written;
          }
        }
      } catch {
        // Never change the answer or recursively log a writer failure.
        this.close();
      }
      return response;
    });
  }
}
