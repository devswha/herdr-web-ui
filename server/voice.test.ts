import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MAX_AUDIO_BYTES, type VoiceEvent, type VoiceStatus, type VoiceUsageReport } from "../shared/voice.ts";
import { handleVoiceRequest, VoiceService } from "./voice.ts";

const KEY = "sk-test-0123456789abcdef";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let stateDir: string;
let requests: Array<{ url: string; init: RequestInit }>;
let handler: Handler;

function service(env: Record<string, string | undefined> = {}): VoiceService {
  return new VoiceService({
    stateDir, env,
    async fetch(url, init) {
      requests.push({ url, init });
      return handler(url, init);
    },
  });
}

function call(voice: VoiceService, pathname: string, init: RequestInit = {}): Promise<Response> {
  return handleVoiceRequest(new Request(`http://localhost${pathname}`, init), pathname, voice);
}

const put = (voice: VoiceService, body: unknown) => call(voice, "/api/voice/config", { method: "PUT", body: JSON.stringify(body) });

function clipForm(fields: { audio?: Blob | null; name?: string; mode?: string; polish?: string; keywords?: string; durationMs?: string } = {}): FormData {
  const form = new FormData();
  const audio = fields.audio === undefined ? new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" }) : fields.audio;
  if (audio) form.append("audio", audio, fields.name ?? "clip.webm");
  form.append("mode", fields.mode ?? "chat");
  form.append("polish", fields.polish ?? "0");
  if (fields.keywords !== undefined) form.append("keywords", fields.keywords);
  if (fields.durationMs !== undefined) form.append("duration_ms", fields.durationMs);
  return form;
}

const transcribe = (voice: VoiceService, form: FormData) => call(voice, "/api/voice/transcribe", { method: "POST", body: form });

async function events(response: Response): Promise<VoiceEvent[]> {
  return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as VoiceEvent);
}

/** an SSE answer cut at fixed byte offsets: mid-line and mid-character */
function sse(events: unknown[], cuts: number[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  const bounds = [0, ...cuts, bytes.length];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const DELTAS = ["안녕하세요 ", "git status ", "실행해 줘"];
function transcriptAnswer(): Response {
  return sse([
    ...DELTAS.map((delta) => ({ type: "transcript.text.delta", delta })),
    { type: "transcript.text.done", text: DELTAS.join("") },
  ], [7, 40, 61, 95, 150]);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-voice-"));
  requests = [];
  handler = () => new Response("unexpected", { status: 500 });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("voice config", () => {
  it("reports no key and the defaults when nothing is set", async () => {
    const response = await call(service(), "/api/voice");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false, source: null, base_url: "https://api.openai.com/v1", transcribe_model: "gpt-transcribe", polish_model: "gpt-6-luna",
    } satisfies VoiceStatus);
  });

  it("takes the env key and refuses to change it", async () => {
    const voice = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    const status = await (await call(voice, "/api/voice")).json() as VoiceStatus;
    expect(status).toMatchObject({ configured: true, source: "env" });
    for (const api_key of ["sk-other", null]) {
      const response = await put(voice, { api_key });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "key_from_env" } });
    }
  });

  it("stores the key owner-only and never answers it", async () => {
    const voice = service();
    const saved = await put(voice, { api_key: ` ${KEY} `, base_url: "http://127.0.0.1:9/v1/" });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(KEY);
    const path = join(stateDir, "voice.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ api_key: KEY });
    const body = await (await call(voice, "/api/voice")).text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body)).toMatchObject({ configured: true, source: "file", base_url: "http://127.0.0.1:9/v1" });
  });

  it("removes the key with null", async () => {
    const voice = service();
    await put(voice, { api_key: KEY });
    const response = await put(voice, { api_key: null });
    expect(await response.json()).toMatchObject({ configured: false, source: null });
    expect(readFileSync(join(stateDir, "voice.json"), "utf8")).not.toContain(KEY);
  });

  it("refuses a base_url that is not http(s) and a wrong method", async () => {
    const voice = service();
    const response = await put(voice, { base_url: "ftp://example.com" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    const wrong = await call(voice, "/api/voice", { method: "POST" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });
});

describe("voice transcribe", () => {
  it("refuses without a key", async () => {
    const response = await transcribe(service(), clipForm());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "voice_not_configured" } });
    expect(requests).toHaveLength(0);
  });

  it("refuses an oversize clip", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ audio: new Blob([new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1)], { type: "audio/webm" }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "audio_too_large" } });
  });

  it("refuses a missing audio part", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ audio: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_audio" } });
  });

  it("refuses a bad mode", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ mode: "shell" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("streams deltas and the done text from a split SSE answer", async () => {
    handler = transcriptAnswer;
    const keywords = JSON.stringify([" git ", "git", "", "server/voice.ts", "x".repeat(81)]);
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ keywords, mode: "terminal" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events(response)).toEqual([
      ...DELTAS.map((text) => ({ type: "delta" as const, text })),
      { type: "done", text: DELTAS.join("") },
    ]);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new Headers(request!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = request!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("stream")).toBe("true");
    expect(form.getAll("languages[]")).toEqual(["ko", "en"]);
    expect(form.getAll("keywords[]")).toEqual(["git", "server/voice.ts"]);
    expect(form.get("prompt")).toBe("Dictation of a shell command line typed into a terminal");
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  it("adds the polished text when asked", async () => {
    handler = (url, init) => {
      if (url.endsWith("/audio/transcriptions")) return transcriptAnswer();
      const body = JSON.parse(String(init.body)) as { model: string; reasoning_effort?: string; temperature?: number; messages: Array<{ content: string }> };
      expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none" });
      expect(body.temperature).toBeUndefined();
      expect(body.messages.at(-1)!.content).toBe(DELTAS.join(""));
      return Response.json({ choices: [{ message: { content: "안녕하세요. `git status` 실행해 줘." } }] });
    };
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ polish: "1" }));
    expect((await events(response)).slice(-2)).toEqual([
      { type: "done", text: DELTAS.join("") },
      { type: "polished", text: "안녕하세요. `git status` 실행해 줘." },
    ]);
    expect(requests.map((request) => request.url)).toEqual(["https://api.openai.com/v1/audio/transcriptions", "https://api.openai.com/v1/chat/completions"]);
  });

  it("sends a model without a reasoning setting a fixed temperature instead", async () => {
    let body: Record<string, unknown> = {};
    handler = (url, init) => {
      if (url.endsWith("/audio/transcriptions")) return transcriptAnswer();
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "tidy" } }] });
    };
    const voice = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    voice.update({ polish_model: "gpt-4.1-mini" });
    await events(await transcribe(voice, clipForm({ polish: "1" })));
    expect(body).toMatchObject({ model: "gpt-4.1-mini", temperature: 0 });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("ends after done when polishing fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      handler = (url) => url.endsWith("/audio/transcriptions") ? transcriptAnswer() : Response.json({ error: { message: `bad key ${KEY}` } }, { status: 500 });
      const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ polish: "1" }));
      const lines = await events(response);
      expect(lines.at(-1)).toEqual({ type: "done", text: DELTAS.join("") });
      expect(lines.some((event) => event.type === "polished" || event.type === "error")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a refused key as provider_auth without echoing it", async () => {
    handler = () => Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 });
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm());
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "provider_auth" } });
    expect(body).not.toContain(KEY);
  });

  it("emits one error line when the provider fails mid-stream", async () => {
    handler = () => sse([{ type: "transcript.text.delta", delta: "안녕" }, { type: "error", error: { message: "server_error" } }], []);
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm());
    expect(await events(response)).toEqual([
      { type: "delta", text: "안녕" },
      { type: "error", code: "provider_error", message: "server_error" },
    ]);
  });
});

describe("voice usage", () => {
  let clock: Date;
  const dated = (env: Record<string, string | undefined> = { HERDR_WEB_OPENAI_API_KEY: KEY }) => new VoiceService({
    stateDir, env, now: () => clock,
    async fetch(url, init) { requests.push({ url, init }); return handler(url, init); },
  });
  const usage = async (voice: VoiceService) => (await (await call(voice, "/api/voice/usage")).json()) as VoiceUsageReport;
  const polishing: Handler = (url) => url.endsWith("/audio/transcriptions")
    ? transcriptAnswer()
    : Response.json({ choices: [{ message: { content: "tidy" } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });

  beforeEach(() => { clock = new Date(2026, 9, 1, 12); });

  it("starts empty", async () => {
    expect(await usage(dated())).toEqual({
      today: { requests: 0, seconds: 0, cost_usd: 0, unpriced: 0 }, month: { requests: 0, seconds: 0, cost_usd: 0, unpriced: 0 },
      total: { requests: 0, seconds: 0, cost_usd: 0, unpriced: 0 }, since: null, prices_as_of: "2026-10-01",
    });
  });

  it("prices the recorder's length per minute and the polish per token", async () => {
    handler = polishing;
    const voice = dated();
    await events(await transcribe(voice, clipForm({ polish: "1", durationMs: "30000" })));
    const report = await usage(voice);
    // 0.5 min x $0.0045 + (1000 x $0.1 + 200 x $0.5) / 1M tokens on gpt-6-luna
    expect(report.today.requests).toBe(1);
    expect(report.today.seconds).toBe(30);
    expect(report.today.cost_usd).toBeCloseTo(0.00225 + 0.0002, 10);
    expect(report.today.unpriced).toBe(0);
    expect(report.month).toEqual(report.today);
    expect(report.total).toEqual(report.today);
    expect(report.since).toBe("2026-10-01");
    expect(statSync(join(stateDir, "voice-usage.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(stateDir, "voice-usage.json"), "utf8")).not.toContain(KEY);
  });

  it("takes the provider's audio length over the recorder's", async () => {
    handler = () => sse([{ type: "transcript.text.done", text: "hi", usage: { type: "duration", seconds: 12 } }], []);
    const voice = dated();
    await events(await transcribe(voice, clipForm({ durationMs: "30000" })));
    const report = await usage(voice);
    expect(report.today.seconds).toBe(12);
    expect(report.today.cost_usd).toBeCloseTo((12 / 60) * 0.0045, 10);
  });

  it("counts a model without a list price as unpriced instead of guessing", async () => {
    handler = transcriptAnswer;
    const voice = dated();
    voice.update({ transcribe_model: "whisper-next" });
    await events(await transcribe(voice, clipForm({ durationMs: "6000" })));
    expect((await usage(voice)).today).toEqual({ requests: 1, seconds: 6, cost_usd: 0, unpriced: 1 });
  });

  it("keeps days apart: today and this month follow the clock, the total keeps everything", async () => {
    handler = transcriptAnswer;
    const voice = dated();
    clock = new Date(2026, 8, 30, 23);
    await events(await transcribe(voice, clipForm({ durationMs: "60000" })));
    clock = new Date(2026, 9, 1, 9);
    await events(await transcribe(voice, clipForm({ durationMs: "120000" })));
    await events(await transcribe(voice, clipForm({ durationMs: "60000" })));
    const report = await usage(voice);
    expect(report.today).toMatchObject({ requests: 2, seconds: 180 });
    expect(report.month).toMatchObject({ requests: 2, seconds: 180 });
    expect(report.total).toMatchObject({ requests: 3, seconds: 240 });
    expect(report.total.cost_usd).toBeCloseTo(4 * 0.0045, 10);
    expect(report.since).toBe("2026-09-30");
  });

  it("records nothing for a request the provider refused", async () => {
    handler = () => Response.json({ error: { message: "nope" } }, { status: 401 });
    const voice = dated();
    expect((await transcribe(voice, clipForm({ durationMs: "5000" }))).status).toBe(502);
    expect((await usage(voice)).total.requests).toBe(0);
  });
});
