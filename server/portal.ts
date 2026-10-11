/**
 * Portal (github.com/gosuda/portal-tunnel): an optional public HTTPS address for this server,
 * started and stopped from Settings → Phone & devices with the `portal` already on this PC; the
 * app never installs it. Tailscale stays the private route and is only ever read (tailscale.ts).
 * Whatever a request asks, the guide's rules for a public proxy hold (docs/guide.md, Behind a
 * reverse proxy):
 *
 * - no address without a token, and none while HERDR_WEB_TAILSCALE_SERVE_ONLY says tailscale serve
 *   is the only way in, not even one an earlier server left running;
 * - routed mode, which keeps the browser's Host and sends X-Forwarded-For and
 *   X-Forwarded-Proto: https, and drops a visitor's Tailscale-User-Login;
 * - one relay the user picked, discovery off, hidden from the relay's list; the identity file kept
 *   here holds the name, and with it the address, across restarts;
 * - only the relay's origin comes from the request, and Portal gets none of this server's
 *   environment beyond what running and reaching the relay need: the token stays here.
 *
 * Portal keeps retrying a relay it cannot use and never exits for it (v2.6.1), so the relay's
 * version is asked first and readiness has a deadline of its own.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { chunksOf } from "./remote-bundle.ts";
import { updateRequestAllowed } from "./update-api.ts";
import { windowsProcessTable } from "./windows-processes.ts";

/** the first release with `--strip-request-header` and an address tied to the identity */
const PORTAL_VERSION = "v2.6.1";
/** a relay that answers but will not take the tunnel is only ever retried, never refused */
const READY_TIMEOUT_MS = 60_000;
/** Portal unregisters from the relay on SIGTERM; one still running after this is killed, within the 6 s the supervisor gives this server to stop */
const STOP_GRACE_MS = 4_000;
const VERSION_TIMEOUT_MS = 2_500;
/** the panel polls the status; `portal version` is a process each time */
const VERSION_CACHE_MS = 5_000;
const RELAY_TIMEOUT_MS = 5_000;
/** what is still in Portal's pipes when it exits: its last words */
const PIPE_GRACE_MS = 250;
/** Portal's last words kept for the panel */
const OUTPUT_LINES = 30;
/** what Portal may keep of this server's environment: enough to run and to reach the relay */
const PORTAL_ENV = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

type Phase = PortalStatus["phase"];
type Child = ReturnType<typeof Bun.spawn>;
interface Guards {
  /** HERDR_WEB_TOKEN is set */
  tokenSet: boolean;
  /** HERDR_WEB_TAILSCALE_SERVE_ONLY: tailscale serve is declared the only way in */
  serveOnly: boolean;
}
interface StartRequest extends Guards {
  relay: string;
  /** this server's port, Portal's upstream */
  port: number;
}
interface SavedState {
  enabled: boolean;
  relay: string | null;
  /** the server that started it: another one on this state directory leaves its Portal alone */
  port: number | null;
  /** the Portal last started, so the next server can stop it if it is still running */
  pid: number | null;
}

export interface PortalServiceOptions {
  /** Portal's identity and on/off choice live in its portal/ */
  stateDir: string;
  /** the portal to run; unset, `portal` from PATH, read at each start */
  bin?: string;
  fetch?: typeof fetch;
  /** READY_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

/** "v2.6.1" → [2, 6, 1]; null for anything else. */
function parseVersion(text: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function atLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

/** A relay as the user gave it, as an https origin; null for anything with a path, a query, credentials or a second host. */
export function relayOrigin(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  // `--relays` takes a comma-separated list, which a URL's host does not refuse
  return /^[a-z0-9.-]+$/i.test(url.hostname) ? url.origin : null;
}

/** The address on Portal's "service ready at" line, without the default port; null for any other line. */
export function readyUrl(line: string): string | null {
  const match = /service ready at (https:\/\/\S+)/.exec(line);
  if (!match) return null;
  try { return new URL(match[1]!).origin; } catch { return null; }
}

function blockedBy({ tokenSet, serveOnly }: Guards): PortalStatus["blocked"] {
  if (!tokenSet) return "token_required";
  if (serveOnly) return "serve_only";
  return null;
}

function portalEnv(): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: "1" };
  for (const name of PORTAL_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Portal's last warning or error, else its last line, for a failure that has no words of its own. */
function lastWords(lines: readonly string[]): string {
  const line = [...lines].reverse().find((candidate) => /\b(WRN|ERR|FTL)\b/.test(candidate)) ?? lines.at(-1);
  return line === undefined ? "" : ` Portal said: ${line}`;
}

async function readVersion(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: portalEnv(), windowsHide: true, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
    const [text, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited]);
    const tag = /\bv?\d+\.\d+\.\d+\S*/.exec(text)?.[0];
    return code === 0 && tag !== undefined ? tag : null;
  } catch { return null; }
}

export class PortalService {
  private phase: Phase = "idle";
  private relay: string | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private lines: string[] = [];
  private child: Child | null = null;
  /** a start between its request and its process, or the boot's cleanup: one at a time */
  private launching = false;
  /** the child asked to end, once: its exit is no failure */
  private ending: Child | null = null;
  private versionRead: { at: number; bin: string | null; value: Promise<string | null> } | null = null;
  private readonly dir: string;

  constructor(private readonly options: PortalServiceOptions) {
    this.dir = join(options.stateDir, "portal");
  }

  private get identityPath(): string { return join(this.dir, "identity.json"); }
  private get statePath(): string { return join(this.dir, "state.json"); }

  private bin(): string | null {
    return this.options.bin ?? Bun.which("portal");
  }

  private version(fresh = false): Promise<string | null> {
    const bin = this.bin();
    const now = Date.now();
    if (!fresh && this.versionRead && this.versionRead.bin === bin && now - this.versionRead.at < VERSION_CACHE_MS) return this.versionRead.value;
    const value = bin === null ? Promise.resolve(null) : readVersion(bin);
    this.versionRead = { at: now, bin, value };
    return value;
  }

  async status(guards: Guards): Promise<PortalStatus> {
    const version = await this.version();
    return {
      supported: true,
      version,
      min_version: PORTAL_VERSION,
      usable: version !== null && atLeast(version, PORTAL_VERSION),
      phase: this.phase,
      relay: this.relay,
      url: this.url,
      blocked: blockedBy(guards),
      error: this.error,
      output: this.lines.length > 0 ? this.lines.join("\n") : null,
    };
  }

  /**
   * At the server's start. A Portal the last server left running is stopped whatever comes next,
   * so a server that may not open the address does not keep one open; an address that was on
   * comes back, so an app update does not take it down for good.
   */
  async resume(request: Omit<StartRequest, "relay">): Promise<void> {
    const saved = this.saved();
    this.relay = saved.relay;
    // a server on another port shares this state directory: what runs is its own
    if (saved.port !== null && saved.port !== request.port) return;
    this.launching = true;
    try { await this.stopLeftover(saved.pid); } finally { this.launching = false; }
    if (saved.enabled && saved.relay !== null && blockedBy(request) === null) this.start({ ...request, relay: saved.relay });
  }

  start(request: StartRequest): "started" | "busy" | "token_required" | "serve_only" {
    const blocked = blockedBy(request);
    if (blocked !== null) return blocked;
    if (this.child !== null || this.launching) return "busy";
    this.phase = "starting";
    this.relay = request.relay;
    this.url = null;
    this.error = null;
    this.lines = [];
    this.launching = true;
    void this.launch(request)
      // a start stopped meanwhile failed for no one
      .catch((error: unknown) => { if (this.phase === "starting") this.fail(messageOf(error)); })
      .finally(() => { this.launching = false; });
    return "started";
  }

  /** Takes the address down, then remembers that it is off. */
  stop(): void {
    this.url = null;
    this.error = null;
    if (this.child !== null) {
      this.phase = "stopping";
      this.end(this.child);
    } else if (this.phase === "starting" || this.phase === "error") {
      // a start still asking its relay ends there
      this.phase = "idle";
    }
    this.save({ enabled: false });
  }

  /** The server is going away: Portal goes with it, and the saved choice stays for the next server. Settles once Portal has exited. */
  shutdown(): Promise<void> {
    const child = this.child;
    if (child === null) {
      if (this.phase === "starting") this.phase = "idle";
      return Promise.resolve();
    }
    this.end(child);
    return child.exited.then(() => undefined);
  }

  private end(child: Child): void {
    if (this.ending === child) return;
    this.ending = child;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), this.options.stopGraceMs ?? STOP_GRACE_MS);
    void child.exited.finally(() => clearTimeout(killer));
  }

  private fail(text: string): void {
    this.phase = "error";
    this.error = text;
    this.url = null;
    if (this.child !== null) this.end(this.child);
  }

  private async launch({ relay, port }: StartRequest): Promise<void> {
    const bin = this.bin();
    const version = bin === null ? null : await this.version(true);
    if (bin === null || version === null) throw new Error("Portal is not installed on this PC.");
    if (!atLeast(version, PORTAL_VERSION)) throw new Error(`This PC has Portal ${version}; the app needs ${PORTAL_VERSION} or later.`);
    await this.checkRelay(relay);
    // another server of this app on this identity: two Portals keep taking the address from each other
    await this.stopLeftover(this.saved().pid);
    // stopped meanwhile; from here to the spawn nothing waits, so a stop comes after it
    if (this.phase !== "starting") return;
    const child = Bun.spawn([
      bin, "expose",
      "--http-route", `/=${port}`,
      "--strip-request-header", "Tailscale-User-Login",
      // a name counts only when the identity file is created; later runs keep the saved one
      "--name", `herdr-${randomBytes(8).toString("hex")}`,
      "--identity-path", this.identityPath,
      "--relays", relay, "--discovery=false",
      "--hide",
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: portalEnv(), windowsHide: true });
    this.child = child;
    const readyTimeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      if (this.child === child && this.phase === "starting") this.fail(`${relay} did not take the tunnel within ${Math.round(readyTimeoutMs / 1000)} seconds.${lastWords(this.lines)}`);
    }, readyTimeoutMs);
    const output = Promise.all([this.follow(child.stdout as ReadableStream<Uint8Array>, child), this.follow(child.stderr as ReadableStream<Uint8Array>, child)]);
    void child.exited.then(async (code) => {
      clearTimeout(deadline);
      await Promise.race([output, Bun.sleep(PIPE_GRACE_MS)]);
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (this.ending === child) {
        this.ending = null;
        if (this.phase !== "error") this.phase = "idle";
        return;
      }
      this.phase = "error";
      this.error = `Portal stopped on its own (exit ${code}).${lastWords(this.lines)}`;
    });
    // a Portal whose pid cannot be kept is one the next server could not stop
    this.save({ enabled: true, relay, port, pid: child.pid });
  }

  /** Portal writes one event a line: the address once a relay takes the tunnel, and why it gave up on one. */
  private async follow(stream: ReadableStream<Uint8Array>, child: Child): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of chunksOf(stream)) {
        pending += decoder.decode(chunk, { stream: true });
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          this.line(pending.slice(0, end), child);
          pending = pending.slice(end + 1);
        }
      }
      this.line(pending + decoder.decode(), child);
    } catch { /* the pipe closes with the process */ }
  }

  private line(raw: string, child: Child): void {
    // NO_COLOR is set; a terminal's codes would be no use here either way
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (line === "" || this.child !== child) return;
    this.lines = [...this.lines, line].slice(-OUTPUT_LINES);
    const url = readyUrl(line);
    if (url !== null) {
      if (this.phase === "starting" || this.phase === "running") {
        this.url = url;
        this.phase = "running";
      }
      return;
    }
    // the relay refused for good (a name it will not take, an incompatible relay): the process would stay up serving nothing
    if (line.includes("relay operation failed permanently") && (this.phase === "starting" || this.phase === "running")) this.fail(line);
  }

  /** A relay Portal cannot use is retried for good and silently: ask the relay first. */
  private async checkRelay(relay: string): Promise<void> {
    let body: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(`${relay}/sdk/domain`, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      throw new Error(`${relay} did not answer as a Portal relay (${messageOf(error)}).`);
    }
    const data = isJsonObject(body) && isJsonObject(body["data"]) ? body["data"] : {};
    const release = typeof data["release_version"] === "string" ? data["release_version"] : "an unknown version";
    if (!atLeast(release, PORTAL_VERSION)) throw new Error(`${relay} runs Portal ${release}; the tunnel needs a relay on ${PORTAL_VERSION} or later.`);
  }

  /**
   * A Portal on this identity that this server did not start: one a server killed outright left
   * running, or one another server of this app runs. A pid outlives its process, so only the one
   * recorded here, and only while its command line is `portal expose` on this identity, is stopped.
   */
  private async stopLeftover(pid: number | null): Promise<void> {
    if (pid === null || pid === this.child?.pid) return;
    let command: string | null = null;
    try {
      if (process.platform === "win32") {
        command = (await windowsProcessTable()).find((row) => row.pid === pid)?.commandLine ?? null;
      } else {
        const ps = Bun.spawn(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL" });
        command = await new Response(ps.stdout as ReadableStream<Uint8Array>).text();
      }
    } catch { /* an unreadable process table tells nothing */ }
    if (command === null || !command.includes(" expose ") || !command.includes(this.identityPath)) return;
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    for (const until = Date.now() + (this.options.stopGraceMs ?? STOP_GRACE_MS); Date.now() < until; await Bun.sleep(100)) {
      try { process.kill(pid, 0); } catch { return; }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
  }

  private saved(): SavedState {
    try {
      const value: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
      if (isJsonObject(value)) {
        const { port, pid } = value;
        return {
          enabled: value["enabled"] === true,
          relay: relayOrigin(value["relay"]),
          port: typeof port === "number" && Number.isInteger(port) ? port : null,
          pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null,
        };
      }
    } catch { /* none yet, or unreadable: nothing is on */ }
    return { enabled: false, relay: null, port: null, pid: null };
  }

  /** at once, not awaited: a stop and a start's own save never interleave */
  private save(change: Partial<SavedState>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify({ ...this.saved(), ...change }), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}

const NO_PORTAL: PortalStatus = { supported: false, version: null, min_version: PORTAL_VERSION, usable: false, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null };

/** /api/portal and its actions. What this server is (its port, token and serve-only setting) comes from index.ts. */
export async function handlePortalRequest(request: Request, pathname: string, portal: PortalService | undefined, context: Omit<StartRequest, "relay">): Promise<Response> {
  const reply = (body: unknown, code = 200) => jsonResponse(body, code, { "cache-control": "no-store" });
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/portal" && request.method === "GET") {
    // a server started without the service (tests, an embedding) offers nothing
    return reply(portal ? await portal.status(context) : NO_PORTAL);
  }
  const action = pathname.slice("/api/portal/".length);
  if (request.method !== "POST" || (action !== "start" && action !== "stop")) {
    return fail("method_not_allowed", "Use GET /api/portal, or POST /api/portal/start or /stop", 405);
  }
  if (!updateRequestAllowed(request)) return fail("invalid_portal_request", "Use the Portal controls from this app.", 403);
  if (!portal) return fail("portal_unsupported", "This server offers no Portal.", 409);
  if (action === "stop") {
    try { portal.stop(); } catch (error) { return errorResponse(error); }
    return reply({ accepted: true }, 202);
  }
  let body: unknown = null;
  try { body = await request.json(); } catch { /* checked below */ }
  const relay = relayOrigin(isJsonObject(body) ? body["relay"] : undefined);
  if (relay === null) return fail("invalid_relay", "Give the relay as an https address, such as https://relay.example.com.", 400);
  const started = portal.start({ ...context, relay });
  if (started === "token_required") return fail("token_required", "Set HERDR_WEB_TOKEN and restart the app before you start Portal: anyone on the internet can open its address.", 409);
  if (started === "serve_only") return fail("serve_only", "Turn off HERDR_WEB_TAILSCALE_SERVE_ONLY and restart the app before you start Portal: it says tailscale serve is the only way in.", 409);
  if (started === "busy") return fail("portal_busy", "Portal is busy; try again once it is idle.", 409);
  return reply({ accepted: true }, 202);
}
