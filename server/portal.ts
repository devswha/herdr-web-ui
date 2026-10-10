/**
 * Portal (github.com/gosuda/portal-tunnel): an optional public HTTPS address for this server,
 * installed, started and stopped from Settings → Phone & devices. Tailscale stays the private
 * route and is only ever read (tailscale.ts). This is the one place where the app itself changes
 * how it can be reached, so it keeps the guide's rules for a public proxy (docs/guide.md, Behind a
 * reverse proxy) whatever the caller asks:
 *
 * - no address without a token, and none while HERDR_WEB_TAILSCALE_SERVE_ONLY says tailscale serve
 *   is the only way in;
 * - routed mode, which keeps the browser's Host and sends X-Forwarded-For and
 *   X-Forwarded-Proto: https, and drops a visitor's Tailscale-User-Login;
 * - one relay the user picked, discovery off, hidden from the relay's list; the identity file kept
 *   here holds the name, and with it the address, across restarts;
 * - the command is built here, never from the request, and Portal gets none of this server's
 *   environment beyond what running and reaching the relay need: the token stays here;
 * - only this PC itself installs or starts it (index.ts decides who that is); any device signed in
 *   that can type may stop it.
 *
 * The binary is the official release checked against the digest pinned below, not against the
 * checksum file beside it, which could be replaced together with the binary. Portal keeps retrying
 * a relay it cannot use and never exits for it (v2.6.1), so readiness has a deadline of its own and
 * the relay's version is asked before the start.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PortalStatus } from "../shared/protocol.ts";
import { isJsonObject, jsonResponse } from "./http.ts";
import { chunksOf } from "./remote-bundle.ts";
import { updateRequestAllowed } from "./update-api.ts";

/** the first release with `--strip-request-header` and an address tied to the identity */
export const PORTAL_VERSION = "v2.6.1";
const RELEASES = "https://github.com/gosuda/portal-tunnel/releases/download";
/** The official v2.6.1 binaries and their digests (its checksums.txt), per `${process.platform}-${process.arch}`. */
const ASSETS: Record<string, readonly [asset: string, sha256: string]> = {
  "darwin-arm64": ["portal-darwin-arm64", "0b5242aa78f035532a8e2a9b450af82278e9e85e68bf267518c5ad6ad785d910"],
  "darwin-x64": ["portal-darwin-amd64", "f2071e830a2f1b07c4fb3b046f66499a7a9772c6a3f95cae3d00b84f9b6b0079"],
  "linux-arm64": ["portal-linux-arm64", "bbc366f21e3d50e9047ce2e185c72895e766e069ccd3b4dc985d15cab65ea066"],
  "linux-x64": ["portal-linux-amd64", "ca70bdcda37502807e2db82cfd31875eefcf0ccc05146a460b7a86b87d5db789"],
  "win32-arm64": ["portal-windows-arm64.exe", "fa6ca9eeb20faeed83201527439e1681e841d963c27c9dc2d0f673a02ab0af71"],
  "win32-x64": ["portal-windows-amd64.exe", "5c1a45007a6307f4d70e124c6d61f57a125ae007b77fd8aa25a484913bfd7a28"],
};
/** a relay that answers but will not take the tunnel is only ever retried, never refused */
const READY_TIMEOUT_MS = 60_000;
/** Portal unregisters from the relay on SIGTERM; one that does not stop in this long is killed */
const STOP_GRACE_MS = 15_000;
const VERSION_TIMEOUT_MS = 2_500;
/** the panel polls the status; `portal version` is a process each time */
const VERSION_CACHE_MS = 5_000;
const RELAY_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Portal's last words kept for the panel */
const OUTPUT_LINES = 30;
/** what Portal may keep of this server's environment: enough to run and to reach the relay */
const PORTAL_ENV = ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TEMP", "TMP", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];

type Phase = PortalStatus["phase"];
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
interface SavedState { enabled: boolean; relay: string | null }

export interface PortalServiceOptions {
  /** Portal's binary, identity and on/off choice live in its portal/ */
  stateDir: string;
  /** the portal to run; unset, HERDR_WEB_PORTAL_BIN, then the one installed here, then `portal` on PATH */
  bin?: string;
  /** `${process.platform}-${process.arch}`, which picks the release */
  platform?: string;
  /** the release to install; unset, the pinned official one for the platform. Tests pass their own. */
  release?: { url: string; sha256: string };
  fetch?: typeof fetch;
  /** READY_TIMEOUT_MS and STOP_GRACE_MS; tests shorten them */
  readyTimeoutMs?: number;
  stopGraceMs?: number;
}

/** "v2.6.1" → [2, 6, 1]; null for anything else. `portal version` prints the tag alone. */
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

/** A relay as the user gave it, as an https origin; null for anything with a path, a query or credentials. */
export function relayOrigin(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return url.origin;
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

async function readVersion(bin: string): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: portalEnv(), windowsHide: true });
  } catch { return null; }
  const timer = setTimeout(() => proc.kill(), VERSION_TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited]);
    return code === 0 && parseVersion(text) !== null ? text.trim() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

export class PortalService {
  private phase: Phase = "idle";
  private relay: string | null = null;
  private url: string | null = null;
  private error: string | null = null;
  private lines: string[] = [];
  private child: ReturnType<typeof Bun.spawn> | null = null;
  /** a start between its request and its process (the relay is asked meanwhile): one at a time */
  private launching = false;
  /** the child the user (or this server's own stop) asked to end: its exit is no failure */
  private ending: ReturnType<typeof Bun.spawn> | null = null;
  private versionRead: { at: number; bin: string | null; value: Promise<string | null> } | null = null;
  private readonly dir: string;

  constructor(private readonly options: PortalServiceOptions) {
    this.dir = join(options.stateDir, "portal");
  }

  private get platform(): string { return this.options.platform ?? `${process.platform}-${process.arch}`; }
  private get installedPath(): string { return join(this.dir, "bin", this.platform.startsWith("win32") ? "portal.exe" : "portal"); }
  private get identityPath(): string { return join(this.dir, "identity.json"); }
  private get statePath(): string { return join(this.dir, "state.json"); }
  private get pidPath(): string { return join(this.dir, "portal.pid"); }

  private release(): { url: string; sha256: string } | null {
    if (this.options.release) return this.options.release;
    const asset = ASSETS[this.platform];
    return asset ? { url: `${RELEASES}/${PORTAL_VERSION}/${asset[0]}`, sha256: asset[1] } : null;
  }

  private bin(): string | null {
    return this.options.bin ?? (process.env["HERDR_WEB_PORTAL_BIN"] || (existsSync(this.installedPath) ? this.installedPath : Bun.which("portal")));
  }

  private version(fresh = false): Promise<string | null> {
    const bin = this.bin();
    const now = Date.now();
    if (!fresh && this.versionRead && this.versionRead.bin === bin && now - this.versionRead.at < VERSION_CACHE_MS) return this.versionRead.value;
    const value = bin === null ? Promise.resolve(null) : readVersion(bin);
    this.versionRead = { at: now, bin, value };
    return value;
  }

  async status(guards: Guards): Promise<Omit<PortalStatus, "here">> {
    const version = await this.version();
    return {
      supported: this.release() !== null || this.bin() !== null,
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

  /** At the server's start: brings the address back if it was on, so an app update does not take it down for good. */
  async resume(request: Omit<StartRequest, "relay">): Promise<void> {
    const saved = await this.saved();
    this.relay = saved.relay;
    if (saved.enabled && saved.relay !== null && blockedBy(request) === null) this.start({ ...request, relay: saved.relay });
  }

  install(): "started" | "busy" | "unsupported" {
    const release = this.release();
    if (release === null) return "unsupported";
    if (this.child !== null || this.launching || this.phase === "installing") return "busy";
    this.phase = "installing";
    this.error = null;
    void this.download(release).then(async () => {
      if (await this.version(true) === null) throw new Error("The downloaded Portal does not run on this PC.");
      this.phase = "idle";
    }).catch((error: unknown) => {
      this.phase = "error";
      this.error = messageOf(error);
    });
    return "started";
  }

  start(request: StartRequest): "started" | "busy" | "token_required" | "serve_only" {
    const blocked = blockedBy(request);
    if (blocked !== null) return blocked;
    if (this.child !== null || this.launching || this.phase === "installing") return "busy";
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

  /** Takes the address down and remembers that it is off. */
  stop(): void {
    this.save({ enabled: false, relay: this.relay });
    this.url = null;
    this.error = null;
    if (this.child === null) {
      // a start still asking its relay ends there
      if (this.phase === "starting" || this.phase === "error") this.phase = "idle";
      return;
    }
    this.phase = "stopping";
    this.end(this.child);
  }

  /** The server is going away: Portal goes with it, and the saved choice stays for the next server. */
  shutdown(): void {
    if (this.child !== null) this.end(this.child);
    else if (this.phase === "starting") this.phase = "idle";
  }

  private end(child: ReturnType<typeof Bun.spawn>): void {
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
    await this.stopOrphan();
    // stopped while the relay was asked; from here to the spawn nothing waits, so a stop comes after it
    if (this.phase !== "starting") return;
    this.save({ enabled: true, relay });
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
    // kept after the exit too: stopOrphan checks what runs under a pid before it stops anything
    writeFileSync(this.pidPath, String(child.pid), { mode: 0o600 });
    const deadline = setTimeout(() => {
      if (this.child !== child || this.phase !== "starting") return;
      const said = this.lines.filter((line) => /\b(WRN|ERR)\b/.test(line)).at(-1);
      this.fail(`${relay} did not take the tunnel within ${Math.round((this.options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} seconds.${said ? ` Portal said: ${said}` : ""}`);
    }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    void this.follow(child.stdout as ReadableStream<Uint8Array>, child);
    void this.follow(child.stderr as ReadableStream<Uint8Array>, child);
    void child.exited.then((code) => {
      clearTimeout(deadline);
      if (this.child !== child) return;
      this.child = null;
      this.url = null;
      if (this.ending === child) {
        this.ending = null;
        if (this.phase !== "error") this.phase = "idle";
        return;
      }
      this.phase = "error";
      this.error = `Portal stopped on its own (exit ${code}).${this.lines.length > 0 ? ` It said: ${this.lines.at(-1)}` : ""}`;
    });
  }

  /** Portal writes one event a line: the address once a relay takes the tunnel, and why it gave up on one. */
  private async follow(stream: ReadableStream<Uint8Array>, child: ReturnType<typeof Bun.spawn>): Promise<void> {
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

  private line(raw: string, child: ReturnType<typeof Bun.spawn>): void {
    // NO_COLOR is set; the colors are stripped anyway, a terminal's codes are no use here
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
    if (line === "" || this.child !== child) return;
    this.lines = [...this.lines, line].slice(-OUTPUT_LINES);
    const url = readyUrl(line);
    if (url !== null) {
      this.url = url;
      if (this.phase === "starting" || this.phase === "running") this.phase = "running";
      return;
    }
    // the relay refused for good (a name it will not take, an incompatible relay): the process would stay up serving nothing
    if (line.includes("relay operation failed permanently")) this.fail(line);
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
   * A Portal an earlier server of this app started and could not stop (it was killed outright):
   * two processes with one identity keep taking the address from each other. Only a process
   * recorded here and running this identity is stopped; Windows has no `ps`, and is left alone.
   */
  private async stopOrphan(): Promise<void> {
    if (process.platform === "win32") return;
    const pid = Number((await readFile(this.pidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) return;
    let command = "";
    try {
      const ps = Bun.spawn(["ps", "-ww", "-o", "command=", "-p", String(pid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      command = await new Response(ps.stdout as ReadableStream<Uint8Array>).text();
    } catch { /* no ps: nothing can be told about the process */ }
    if (!command.includes(" expose ") || !command.includes(this.identityPath)) {
      await rm(this.pidPath, { force: true });
      return;
    }
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    for (const until = Date.now() + (this.options.stopGraceMs ?? STOP_GRACE_MS); Date.now() < until; await Bun.sleep(100)) {
      try { process.kill(pid, 0); } catch { return; }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
  }

  /** The release to portal/bin/, checked on the way; a partial or mismatched file never takes the name. */
  private async download(release: { url: string; sha256: string }): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok || !response.body) throw new Error(`Portal could not be downloaded (HTTP ${response.status}).`);
    await mkdir(join(this.dir, "bin"), { recursive: true, mode: 0o700 });
    const part = `${this.installedPath}.part-${process.pid}-${Date.now()}`;
    const sink = Bun.file(part).writer();
    const hash = createHash("sha256");
    try {
      for await (const chunk of chunksOf(response.body)) {
        hash.update(chunk); sink.write(chunk); await sink.flush();
      }
      await sink.end();
      if (hash.digest("hex") !== release.sha256) throw new Error("The download does not match the official Portal release; nothing was installed.");
      await chmod(part, 0o755);
      await rename(part, this.installedPath);
    } catch (error) {
      try { await sink.end(); } catch { /* already ended */ }
      await rm(part, { force: true });
      throw error;
    }
  }

  private async saved(): Promise<SavedState> {
    try {
      const value: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!isJsonObject(value)) return { enabled: false, relay: null };
      return { enabled: value["enabled"] === true, relay: relayOrigin(value["relay"]) };
    } catch { return { enabled: false, relay: null }; }
  }

  /** at once, not awaited: a stop and a start's own save never interleave */
  private save(state: SavedState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}

/** Who asks, and what this server is: index.ts knows, Portal's rules here decide. */
export interface PortalRequestContext extends Guards {
  /** a loopback connection that came through no proxy: this PC itself, the only one that may install or start */
  here: boolean;
  port: number;
}

const NO_PORTAL: Omit<PortalStatus, "here"> = { supported: false, version: null, min_version: PORTAL_VERSION, usable: false, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null };

export async function handlePortalRequest(request: Request, pathname: string, portal: PortalService | undefined, context: PortalRequestContext): Promise<Response> {
  const reply = (body: unknown, code = 200) => jsonResponse(body, code, { "cache-control": "no-store" });
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/portal" && request.method === "GET") {
    // a server started without the service (tests, an embedding) offers nothing
    const status = portal ? await portal.status(context) : NO_PORTAL;
    return reply({ ...status, here: context.here } satisfies PortalStatus);
  }
  const action = pathname.slice("/api/portal/".length);
  if (request.method !== "POST" || (action !== "install" && action !== "start" && action !== "stop")) {
    return fail("method_not_allowed", "Use GET /api/portal, or POST /api/portal/install, /start or /stop", 405);
  }
  if (!updateRequestAllowed(request)) return fail("invalid_portal_request", "Use the Portal controls from this app.", 403);
  if (!portal) return fail("portal_unsupported", "This server offers no Portal.", 409);
  if (action === "stop") {
    portal.stop();
    return reply({ accepted: true }, 202);
  }
  // a public address is opened only by someone at this PC, never through a proxy (Portal's own address included)
  if (!context.here) return fail("portal_not_here", "Install or start Portal on this PC itself, not through another device or a proxy.", 403);
  if (action === "install") {
    const started = portal.install();
    if (started === "unsupported") return fail("portal_unsupported", "Portal has no release for this PC.", 409);
    if (started === "busy") return fail("portal_busy", "Portal is busy; try again once it is idle.", 409);
    return reply({ accepted: true }, 202);
  }
  let body: unknown = null;
  try { body = await request.json(); } catch { /* checked below */ }
  const relay = relayOrigin(isJsonObject(body) ? body["relay"] : undefined);
  if (relay === null) return fail("invalid_relay", "Give the relay as an https address, such as https://relay.example.com.", 400);
  const started = portal.start({ ...context, relay });
  if (started === "token_required") return fail("token_required", "Set HERDR_WEB_TOKEN before you start Portal: anyone on the internet can open its address.", 409);
  if (started === "serve_only") return fail("serve_only", "Turn off HERDR_WEB_TAILSCALE_SERVE_ONLY before you start Portal: it says tailscale serve is the only way in.", 409);
  if (started === "busy") return fail("portal_busy", "Portal is busy; try again once it is idle.", 409);
  return reply({ accepted: true }, 202);
}
