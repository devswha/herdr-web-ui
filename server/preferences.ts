import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_PREFERENCES_BYTES, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";

/**
 * The preferences every browser of this server shares (shared/preferences.ts), kept in the state
 * directory beside devices.json. One document: a browser sends the settings it changed (and the
 * pins when they changed), laid over what is held, last write wins per setting; the others take
 * the whole document from the event.
 */
export class PreferenceStore {
  private current: SharedPreferences = { revision: 0, settings: {}, pins: [] };
  private readonly path: string;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();

  constructor(stateDir: string) {
    this.path = join(stateDir, "preferences.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const body = sharedPreferencesBody(parsed);
      const revision = isJsonObject(parsed) && Number.isSafeInteger(parsed["revision"]) ? parsed["revision"] as number : 0;
      if (body !== null) this.current = { revision: Math.max(0, revision), settings: body.settings, pins: body.pins ?? [] };
    } catch (error) {
      // a missing file is a server that has shared nothing yet; a damaged one is replaced by the next write
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Cannot read ${this.path}; shared preferences start empty`);
    }
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    this.current = { revision: this.current.revision + 1, settings: { ...this.current.settings, ...change.settings }, pins: change.pins ?? this.current.pins };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** /api/preferences: GET the shared document, PUT a new one. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  if (request.method === "GET") return reply(store.get());
  if (request.method !== "PUT") return reply({ error: { code: "method_not_allowed", message: "Use GET or PUT /api/preferences" } }, 405);
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_PREFERENCES_BYTES) return reply({ error: { code: "too_large", message: "Shared preferences are at most 64 KB" } }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const body = sharedPreferencesBody(raw);
  if (body === null) return badRequest("invalid_body", "Send { settings: object, pins?: string[] }");
  try { return reply(store.set(body)); }
  catch (error) { return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500); }
}
