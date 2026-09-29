/**
 * The plan limits of the AI subscriptions this PC's CLIs are signed in to, read with each CLI's
 * own sign-in: how much of the 5-hour session, the week or the billing month is used, and when it
 * starts over.
 *
 * Where each sign-in lives and which endpoint states its limits follows OpenUsage
 * (github.com/robinebers/openusage, MIT, at 2d2eabe).
 *
 * Read only, on purpose: an OAuth token is never refreshed here. Claude, Codex, Cursor and Grok
 * rotate refresh tokens, so a refresh the CLI did not make logs the CLI out. An expired token is
 * reported as `expired` instead; the CLI refreshes its own file the next time it runs.
 *
 * Nothing runs in the background: a provider is asked only when a client asks this server, at
 * most every FRESH_MS unless the client forces it, which is still limited to one ask per
 * MIN_REFRESH_MS. A provider that answered 429 is not asked again before it said to.
 */

import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsage, UsageProblem, UsageProviderId, UsageReport, UsageWindow } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";

export const FRESH_MS = 5 * 60_000;
export const MIN_REFRESH_MS = 30_000;
/** after a failure or an expired sign-in: soon enough to pick up the CLI's next refresh */
export const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const USER_AGENT = "herdr-web-ui";
/** the most a credential file, a command's output or a provider's answer may hold; more is unreadable */
export const MAX_READ_BYTES = 1024 * 1024;

export type KeychainRead = { status: "found"; value: string } | { status: "missing" } | { status: "locked" };

/** Everything a provider touches outside this file, so tests can stand in for it. */
export interface UsageContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fetch(url: string, init: RequestInit): Promise<Response>;
  keychain(service: string, account?: string): Promise<KeychainRead>;
  /** a command's trimmed stdout, or null when it is missing, fails or hangs */
  run(argv: string[]): Promise<string | null>;
  now(): number;
}

interface SignIn {
  token: string;
  /** epoch ms; null when the sign-in does not say */
  expiresAt: number | null;
  plan?: string | null;
  account?: string | null;
  /** further tokens of the same account, tried in order when the service refuses the one before */
  fallbacks?: string[];
}

interface Reading {
  plan: string | null;
  windows: UsageWindow[];
}

export interface UsageProvider {
  id: UsageProviderId;
  /** null: not signed in here. "locked": signed in, in a keychain this session cannot read. */
  signIn(ctx: UsageContext): Promise<SignIn | "locked" | null>;
  /** null: signed in, but to an account without this plan */
  read(ctx: UsageContext, signIn: SignIn): Promise<Reading | null>;
}

/** an answer past MAX_READ_BYTES */
class UsageTooLarge extends Error {}

export class UsageHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`HTTP ${status}`);
  }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
/** a number, or a proto-JSON int64 (sent as a string) */
const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

function parseJson(source: string | null): unknown {
  if (source === null) return null;
  try { return JSON.parse(source); } catch { return null; }
}

function readText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= MAX_READ_BYTES; size += read) read = readSync(fd, buffer, size, buffer.length - size, null);
    return size > MAX_READ_BYTES ? null : buffer.toString("utf8", 0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A stream's text up to MAX_READ_BYTES; null past it, the rest left unread. */
async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READ_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** ISO 8601 from an ISO string or epoch seconds or milliseconds */
function isoTime(value: unknown): string | null {
  const n = number(value);
  if (n !== null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const s = text(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function epochMs(value: unknown): number | null {
  const iso = isoTime(value);
  return iso === null ? null : Date.parse(iso);
}

function jwtClaims(token: string): Json {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try { return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { return {}; }
}

function jwtExpiry(token: string): number | null {
  const exp = number(jwtClaims(token)["exp"]);
  return exp === null ? null : exp * 1000;
}

/** The span a limit counts over, from its length in seconds. */
function kindOf(seconds: number | null, fallback: UsageWindow["kind"]): UsageWindow["kind"] {
  if (seconds === null || seconds <= 0) return fallback;
  if (seconds <= 6 * 3600) return "session";
  if (seconds <= 36 * 3600) return "day";
  if (seconds <= 8 * 86400) return "week";
  return "month";
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function requestJson(ctx: UsageContext, url: string, init: RequestInit): Promise<Json> {
  const response = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UsageHttpError(response.status, retryAfter(response.headers.get("retry-after")));
  }
  const body = await readCapped(response.body);
  if (body === null) throw new UsageTooLarge(`${new URL(url).host} answered more than ${MAX_READ_BYTES} bytes`);
  return record(JSON.parse(body));
}

/** The first keychain item that yields a sign-in; "locked" when one exists but could not be read. */
async function fromKeychain(ctx: UsageContext, service: string, accounts: Array<string | undefined>, parse: (value: string) => SignIn | null): Promise<SignIn | "locked" | null> {
  if (ctx.platform !== "darwin") return null;
  for (const account of accounts) {
    const found = await ctx.keychain(service, account);
    if (found.status === "locked") return "locked";
    if (found.status === "found") {
      const signIn = parse(found.value);
      if (signIn) return signIn;
    }
  }
  return null;
}

// ---- Claude Code: keychain `Claude Code-credentials` on macOS, else ~/.claude/.credentials.json ----

function claudeSignIn(source: string | null): SignIn | null {
  const oauth = record(record(parseJson(source))["claudeAiOauth"]);
  const token = text(oauth["accessToken"]);
  return token ? { token, expiresAt: number(oauth["expiresAt"]), plan: text(oauth["subscriptionType"]) } : null;
}

function claudeWindow(value: unknown, kind: UsageWindow["kind"], scope: string | null): UsageWindow | null {
  const window = record(value);
  const used = number(window["utilization"]);
  return used === null ? null : { kind, scope, used_percent: percent(used), resets_at: isoTime(window["resets_at"]) };
}

const claude: UsageProvider = {
  id: "claude",
  async signIn(ctx) {
    const user = ctx.env["USER"];
    const keychain = await fromKeychain(ctx, "Claude Code-credentials", user ? [user, undefined] : [undefined], claudeSignIn);
    if (keychain && keychain !== "locked") return keychain;
    const file = claudeSignIn(readText(join(ctx.env["CLAUDE_CONFIG_DIR"] || join(ctx.home, ".claude"), ".credentials.json")));
    return file ?? keychain;
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": USER_AGENT },
    });
    const windows = [
      claudeWindow(body["five_hour"], "session", null),
      claudeWindow(body["seven_day"], "week", null),
      claudeWindow(body["seven_day_opus"], "week", "Opus"),
      claudeWindow(body["seven_day_sonnet"], "week", "Sonnet"),
    ].filter((window): window is UsageWindow => window !== null);
    return { plan: null, windows };
  },
};

// ---- Codex: auth.json under CODEX_HOME, ~/.config/codex or ~/.codex; keychain `Codex Auth` ----

function codexSignIn(source: string | null): SignIn | null {
  const tokens = record(record(parseJson(source))["tokens"]);
  const token = text(tokens["access_token"]);
  if (!token) return null;
  const plan = text(record(jwtClaims(token)["https://api.openai.com/auth"])["chatgpt_plan_type"]);
  return { token, expiresAt: jwtExpiry(token), plan, account: text(tokens["account_id"]) };
}

function codexWindow(value: unknown, now: number): UsageWindow | null {
  const window = record(value);
  const used = number(window["used_percent"]);
  if (used === null) return null;
  const after = number(window["reset_after_seconds"]);
  return {
    kind: kindOf(number(window["limit_window_seconds"]), "session"),
    scope: null,
    used_percent: percent(used),
    resets_at: isoTime(window["reset_at"]) ?? (after === null ? null : new Date(now + after * 1000).toISOString()),
  };
}

const codex: UsageProvider = {
  id: "codex",
  async signIn(ctx) {
    const homes = [ctx.env["CODEX_HOME"], join(ctx.home, ".config", "codex"), join(ctx.home, ".codex")];
    for (const home of homes) {
      const signIn = home ? codexSignIn(readText(join(home, "auth.json"))) : null;
      if (signIn) return signIn;
    }
    return fromKeychain(ctx, "Codex Auth", [undefined], codexSignIn);
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${signIn.token}`, accept: "application/json", "user-agent": USER_AGENT,
        ...(signIn.account ? { "chatgpt-account-id": signIn.account } : {}),
      },
    });
    const limits = record(body["rate_limit"]);
    const now = ctx.now();
    const windows = [codexWindow(limits["primary_window"], now), codexWindow(limits["secondary_window"], now)]
      .filter((window): window is UsageWindow => window !== null);
    return { plan: text(body["plan_type"]), windows };
  },
};

// ---- Cursor: the app's state.vscdb, or the cursor-agent CLI's keychain item ----

function cursorDatabase(ctx: UsageContext): string {
  return ctx.platform === "darwin"
    ? join(ctx.home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAppSignIn(path: string): SignIn | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const value = (key: string) => text(db!.query<{ value: unknown }, [string, number]>("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?").get(key, MAX_READ_BYTES)?.value);
    const token = value("cursorAuth/accessToken");
    return token ? { token, expiresAt: jwtExpiry(token), plan: value("cursorAuth/stripeMembershipType") } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const cursor: UsageProvider = {
  id: "cursor",
  async signIn(ctx) {
    const app = cursorAppSignIn(cursorDatabase(ctx));
    const cli = await fromKeychain(ctx, "cursor-access-token", [undefined], (value) => {
      const token = text(value);
      return token ? { token, expiresAt: jwtExpiry(token) } : null;
    });
    if (!app) return cli;
    if (!cli || cli === "locked") return app;
    // both signed in: the one that stays valid longer is the one in use
    return (cli.expiresAt ?? 0) > (app.expiresAt ?? 0) ? { ...cli, plan: app.plan ?? null } : app;
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, "content-type": "application/json", "connect-protocol-version": "1", "user-agent": USER_AGENT },
      body: "{}",
    });
    const plan = record(body["planUsage"]);
    const limit = number(plan["limit"]);
    const remaining = number(plan["remaining"]);
    const used = number(plan["totalPercentUsed"]) ?? (limit && remaining !== null ? (limit - remaining) / limit * 100 : null);
    const resetsAt = isoTime(body["billingCycleEnd"]);
    // the plan-wide share, then the two allowances inside it: Cursor's own models (Auto) and the rest (API)
    const windows = [[used, null], [number(plan["autoPercentUsed"]), "Cursor models"], [number(plan["apiPercentUsed"]), "Other models"]]
      .filter((entry): entry is [number, string | null] => entry[0] !== null)
      .map(([share, scope]): UsageWindow => ({ kind: "month", scope, used_percent: percent(share), resets_at: resetsAt }));
    return { plan: null, windows };
  },
};

// ---- GitHub Copilot: the editor plugin's sign-in, else the GitHub CLI's ----

function copilotFileToken(source: string | null): string | null {
  for (const [host, entry] of Object.entries(record(parseJson(source)))) {
    const token = host.startsWith("github.com") ? text(record(entry)["oauth_token"]) : null;
    if (token) return token;
  }
  return null;
}

function copilotWindow(value: unknown, scope: string, resetsAt: string | null): UsageWindow | null {
  const quota = record(value);
  const entitlement = number(quota["entitlement"]);
  const left = number(quota["percent_remaining"]);
  if (quota["unlimited"] === true || entitlement === null || entitlement <= 0 || left === null) return null;
  return { kind: "month", scope, used_percent: percent(100 - left), resets_at: resetsAt };
}

const copilot: UsageProvider = {
  id: "copilot",
  async signIn(ctx) {
    const dir = join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "github-copilot");
    // an editor sign-in can outlive its token by years: the GitHub CLI's is the next to try
    const tokens = [...new Set([
      copilotFileToken(readText(join(dir, "apps.json"))), copilotFileToken(readText(join(dir, "hosts.json"))),
      text(await ctx.run(["gh", "auth", "token", "--hostname", "github.com"])),
    ].filter((token): token is string => token !== null))];
    return tokens.length ? { token: tokens[0]!, expiresAt: null, fallbacks: tokens.slice(1) } : null;
  },
  async read(ctx, signIn) {
    // The tokens may belong to different GitHub accounts: the first one with Copilot answers. A 404
    // is an account without it; only when every token says so is Copilot left out.
    let body: Json | null = null;
    let refusal: UsageHttpError | null = null;
    for (const token of [signIn.token, ...signIn.fallbacks ?? []]) {
      try {
        body = await requestJson(ctx, "https://api.github.com/copilot_internal/user", {
          headers: {
            authorization: `token ${token}`, accept: "application/json", "user-agent": "GitHubCopilotChat/0.26.7",
            "editor-version": "vscode/1.96.2", "editor-plugin-version": "copilot-chat/0.26.7", "x-github-api-version": "2025-04-01",
          },
        });
        break;
      } catch (error) {
        if (!(error instanceof UsageHttpError) || ![401, 403, 404].includes(error.status)) throw error;
        if (error.status !== 404) refusal = error;
      }
    }
    if (body === null) {
      if (refusal) throw refusal;
      return null;
    }
    const resetsAt = isoTime(body["quota_reset_date"]);
    const snapshots = record(body["quota_snapshots"]);
    const windows = [
      copilotWindow(snapshots["premium_interactions"], "Premium", resetsAt),
      copilotWindow(snapshots["chat"], "Chat", resetsAt),
      copilotWindow(snapshots["completions"], "Completions", resetsAt),
    ].filter((window): window is UsageWindow => window !== null);
    // Copilot Free states what is left of a monthly allowance instead
    const left = record(body["limited_user_quotas"]);
    const monthly = record(body["monthly_quotas"]);
    for (const [key, scope] of [["chat", "Chat"], ["completions", "Completions"]] as const) {
      const total = number(monthly[key]);
      const remaining = number(left[key]);
      if (total && total > 0 && remaining !== null && !windows.some((window) => window.scope === scope)) {
        windows.push({ kind: "month", scope, used_percent: percent((total - remaining) / total * 100), resets_at: isoTime(body["limited_user_reset_date"]) ?? resetsAt });
      }
    }
    // Copilot Free reports its plan as "individual"; only the SKU tells them apart
    const plan = text(body["access_type_sku"])?.includes("free") ? "free" : text(body["copilot_plan"]);
    return { plan, windows };
  },
};

// ---- Grok CLI: ~/.grok/auth.json ----

const PERIOD_KINDS: Record<string, UsageWindow["kind"]> = {
  USAGE_PERIOD_TYPE_DAILY: "day", USAGE_PERIOD_TYPE_WEEKLY: "week", USAGE_PERIOD_TYPE_MONTHLY: "month",
};

const grok: UsageProvider = {
  id: "grok",
  async signIn(ctx) {
    for (const entry of Object.values(record(parseJson(readText(join(ctx.home, ".grok", "auth.json")))))) {
      const value = record(entry);
      const token = text(value["key"]);
      if (token) return { token, expiresAt: epochMs(value["expires_at"] ?? value["expires"]) };
    }
    return null;
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: { authorization: `Bearer ${signIn.token}`, "x-xai-token-auth": "xai-grok-cli", accept: "application/json", "user-agent": USER_AGENT },
    });
    const config = record(body["config"]);
    const period = record(config["currentPeriod"]);
    const stated = number(config["creditUsagePercent"]);
    const knownKind = PERIOD_KINDS[text(period["type"]) ?? ""];
    // an answer that states neither is not a plan's usage, whatever its status
    if (stated === null && knownKind === undefined) return { plan: null, windows: [] };
    const start = epochMs(period["start"]);
    const end = epochMs(period["end"]);
    const kind = knownKind ?? kindOf(start !== null && end !== null ? (end - start) / 1000 : null, "month");
    // proto-JSON leaves a zero out: a stated period without a percent is nothing used
    return { plan: null, windows: [{ kind, scope: null, used_percent: percent(stated ?? 0), resets_at: isoTime(period["end"]) }] };
  },
};

// ---- Antigravity (Google's Gemini and third-party model quota): keychain `gemini` / `antigravity` ----

function antigravitySignIn(value: string): SignIn | null {
  const encoded = value.startsWith("go-keyring-base64:") ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8") : value;
  const token = record(record(parseJson(encoded))["token"]);
  const access = text(token["access_token"]);
  return access ? { token: access, expiresAt: epochMs(token["expiry"]) } : null;
}

const ANTIGRAVITY_BUCKETS: Record<string, { kind: UsageWindow["kind"]; scope: string | null }> = {
  "gemini-5h": { kind: "session", scope: null },
  "gemini-weekly": { kind: "week", scope: null },
  "3p-5h": { kind: "session", scope: "Other models" },
  "3p-weekly": { kind: "week", scope: "Other models" },
};

const antigravity: UsageProvider = {
  id: "antigravity",
  signIn: (ctx) => fromKeychain(ctx, "gemini", ["antigravity"], antigravitySignIn),
  async read(ctx, signIn) {
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "antigravity" },
      body: "{}",
    };
    let body: Json;
    try {
      body = await requestJson(ctx, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    } catch (error) {
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
      body = await requestJson(ctx, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    }
    const groups = body["groups"] ?? record(body["response"])["groups"];
    const windows: UsageWindow[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const buckets = record(group)["buckets"];
      for (const bucket of Array.isArray(buckets) ? buckets : []) {
        const value = record(bucket);
        const shape = ANTIGRAVITY_BUCKETS[text(value["bucketId"]) ?? ""];
        const remaining = number(value["remainingFraction"]);
        // no fraction is left out, as OpenUsage does, rather than shown as 0% or 100% used
        if (shape && remaining !== null) windows.push({ ...shape, used_percent: percent((1 - remaining) * 100), resets_at: isoTime(value["resetTime"]) });
      }
    }
    return { plan: null, windows };
  },
};

export const USAGE_PROVIDERS: readonly UsageProvider[] = [claude, codex, cursor, copilot, grok, antigravity];

/** Keychain services whose read hung (an access prompt nobody answered): not asked again. */
const promptedServices = new Set<string>();

async function readKeychain(service: string, account?: string): Promise<KeychainRead> {
  if (promptedServices.has(service)) return { status: "locked" };
  const child = Bun.spawn(["security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, COMMAND_TIMEOUT_MS);
  try {
    const output = await readCapped(child.stdout);
    if (output === null) child.kill();
    const code = await child.exited;
    if (output === null) return { status: "missing" };
    if (code === 0) return { status: "found", value: output.trim() };
    // 44: errSecItemNotFound. Anything else found an item it could not read (36: a locked keychain).
    if (code === 44 && !timedOut) return { status: "missing" };
    if (timedOut) promptedServices.add(service);
    return { status: "locked" };
  } catch {
    return { status: "missing" };
  } finally {
    clearTimeout(timer);
  }
}

export async function runCommand(argv: string[]): Promise<string | null> {
  if (!Bun.which(argv[0]!)) return null;
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    try {
      const output = await readCapped(child.stdout);
      if (output === null) child.kill();
      const code = await child.exited;
      return code === 0 && output !== null ? output.trim() : null;
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  }
}

export function systemUsageContext(): UsageContext {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    fetch: (url, init) => fetch(url, init),
    keychain: readKeychain,
    run: runCommand,
    now: Date.now,
  };
}

interface Entry {
  /** null: not signed in, or signed in without this plan */
  usage: ProviderUsage | null;
  readAt: number;
  nextAt: number;
}

export class UsageService {
  private readonly entries = new Map<UsageProviderId, Entry>();
  private pending: Promise<UsageReport> | null = null;
  private pendingRefresh = false;

  constructor(private readonly ctx: UsageContext = systemUsageContext(), private readonly providers: readonly UsageProvider[] = USAGE_PROVIDERS) {}

  /**
   * `refresh` asks again sooner than FRESH_MS. Concurrent callers share one pass; a refresh that
   * arrives during a plain pass runs after it, so no provider it could force is answered from cache.
   */
  report(refresh = false): Promise<UsageReport> {
    if (this.pending && (!refresh || this.pendingRefresh)) return this.pending;
    const pass: Promise<UsageReport> = (this.pending ?? Promise.resolve())
      .then(() => this.collect(refresh))
      .finally(() => { if (this.pending === pass) { this.pending = null; this.pendingRefresh = false; } });
    this.pending = pass;
    this.pendingRefresh = refresh;
    return pass;
  }

  private async collect(refresh: boolean): Promise<UsageReport> {
    const now = this.ctx.now();
    const usages = await Promise.all(this.providers.map(async (provider) => {
      const entry = this.entries.get(provider.id);
      const forced = refresh && entry !== undefined && now - entry.readAt >= MIN_REFRESH_MS && entry.usage?.problem !== "rate_limited";
      if (entry && now < entry.nextAt && !forced) return entry.usage;
      const next = await this.read(provider, entry?.usage ?? null, now);
      this.entries.set(provider.id, next);
      return next.usage;
    }));
    return { providers: usages.filter((usage): usage is ProviderUsage => usage !== null) };
  }

  private async read(provider: UsageProvider, previous: ProviderUsage | null, now: number): Promise<Entry> {
    const settle = (usage: ProviderUsage | null, wait: number): Entry => ({ usage, readAt: now, nextAt: now + wait });
    // the last numbers stay, named by what went wrong since
    const keep = (problem: UsageProblem, plan: string | null, wait: number) => settle({
      id: provider.id, plan: previous?.plan ?? plan, windows: previous?.windows ?? [], problem, checked_at: previous?.checked_at ?? null,
    }, wait);
    let signIn: SignIn | "locked" | null;
    try { signIn = await provider.signIn(this.ctx); } catch { signIn = null; }
    if (signIn === null) return settle(null, FRESH_MS);
    if (signIn === "locked") return keep("locked", null, FRESH_MS);
    if (signIn.expiresAt !== null && signIn.expiresAt <= now) return keep("expired", signIn.plan ?? null, RETRY_MS);
    try {
      const reading = await provider.read(this.ctx, signIn);
      if (reading === null) return settle(null, FRESH_MS);
      return settle({
        id: provider.id, plan: reading.plan ?? signIn.plan ?? null, windows: reading.windows, problem: null, checked_at: new Date(now).toISOString(),
      }, FRESH_MS);
    } catch (error) {
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403)) return keep("expired", signIn.plan ?? null, RETRY_MS);
      if (error instanceof UsageHttpError && error.status === 429) return keep("rate_limited", signIn.plan ?? null, Math.max(RETRY_MS, error.retryAfterMs ?? FRESH_MS));
      console.warn(`usage: ${provider.id} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return keep("failed", signIn.plan ?? null, RETRY_MS);
    }
  }
}

export async function handleUsageRequest(request: Request, url: URL, service: UsageService): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/usage" } }, 405, { allow: "GET" });
  return jsonResponse(await service.report(url.searchParams.get("refresh") === "1"), 200, { "cache-control": "no-store" });
}
