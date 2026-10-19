import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The context window a pi model runs in.
 *
 * A pi transcript records what a request filled but never the window it filled, so the
 * percentage the composer's ring shows cannot come from the file. pi answers it from its
 * own model registry, which lives in the process (`getBuiltinModel`, compiled into the
 * bundle) and is refreshed over the network, so a reader of the transcript cannot duplicate
 * it. What it can read are the catalogs pi does keep on disk:
 *
 *  - `models.json` — the user's custom providers (pi's default location, moved by
 *    `PI_CODING_AGENT_DIR`), the only file pi's own footer consults;
 *  - `commandcode-models.json` — the commandcode provider's cached catalog, which states a
 *    window for every model pi offers through it;
 *  - `models-store.json` — pi's store for the other providers it knows on disk.
 *
 * So this resolves what those files state and nothing else. A model pi knows only from its
 * built-in registry, a provider whose entry omits `contextWindow`, and a model that names none
 * while its provider states one (pi does not inherit that number) all stay unresolved and the
 * ring is not drawn: guessing a window would draw a percentage the user cannot tell from pi's
 * own. pi's footer does the same, showing `?` in place of a number.
 */

type PiModel = { id?: unknown; contextWindow?: unknown };
type PiProvider = { models?: unknown; modelOverrides?: unknown };
type PiCatalog = { providers?: Record<string, PiProvider> };

/** pi strips a BOM and `//` comments before parsing this file, so a commented file still loads. */
function parse(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : "")).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
  try { return JSON.parse(stripped); } catch { return null; }
}

function windowsFromModelsJson(provider: PiProvider): Map<string, number> {
  const list: unknown[] = Array.isArray(provider.models) ? provider.models : [];
  const overrides = (provider as { modelOverrides?: unknown }).modelOverrides;
  const models = new Map<string, number>();
  for (const value of list) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as PiModel;
    if (typeof model.id !== "string") continue;
    const listed = overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)
      ? (overrides as Record<string, unknown>)[model.id]
      : undefined;
    const override = listed !== null && typeof listed === "object" && !Array.isArray(listed) ? listed as PiModel : undefined;
    const window = override?.contextWindow ?? model.contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    models.set(model.id, window);
  }
  return models;
}

/** A flat list of `{ id, contextWindow }` entries, as pi's commandcode cache stores them. */
function windowsFromFlatList(list: unknown): Map<string, number> {
  const models = new Map<string, number>();
  if (!Array.isArray(list)) return models;
  for (const value of list) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const model = value as PiModel;
    if (typeof model.id !== "string") continue;
    const window = model.contextWindow;
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) continue;
    models.set(model.id, window);
  }
  return models;
}

type CachedCatalog = { content: string; byProvider: Map<string, Map<string, number>> };

const cache = new Map<string, CachedCatalog | null>();

/** Read and cache a catalog file. Returns null when the file is absent or unreadable. */
function readCatalog(path: string, parseCatalog: (parsed: unknown) => Map<string, Map<string, number>> | null): CachedCatalog | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { cache.set(path, null); return null; }
  const cached = cache.get(path);
  if (cached && cached.content === text) return cached;
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { parsed = parse(text); }
  const byProvider = parseCatalog(parsed);
  const entry: CachedCatalog | null = byProvider === null ? null : { content: text, byProvider };
  cache.set(path, entry);
  return entry;
}

function modelsJsonCatalog(parsed: unknown): Map<string, Map<string, number>> | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const catalog = parsed as PiCatalog;
  if (catalog.providers === undefined || catalog.providers === null || typeof catalog.providers !== "object") return null;
  const byProvider = new Map<string, Map<string, number>>();
  for (const [id, provider] of Object.entries(catalog.providers)) {
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)) continue;
    byProvider.set(id, windowsFromModelsJson(provider));
  }
  return byProvider;
}

function commandCodeCatalog(parsed: unknown): Map<string, Map<string, number>> | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { models?: unknown };
  if (!Array.isArray(record.models)) return null;
  const byProvider = new Map<string, Map<string, number>>();
  byProvider.set("commandcode", windowsFromFlatList(record.models));
  return byProvider;
}

function modelsStoreCatalog(parsed: unknown): Map<string, Map<string, number>> | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const byProvider = new Map<string, Map<string, number>>();
  let found = false;
  for (const [id, value] of Object.entries(record)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const provider = value as { models?: unknown };
    if (!Array.isArray(provider.models)) continue;
    byProvider.set(id, windowsFromFlatList(provider.models));
    found = true;
  }
  return found ? byProvider : null;
}

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"];
  return typeof dir === "string" && dir.length > 0 ? (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir) : join(homedir(), ".pi", "agent");
}

/**
 * The window a model runs in, by the provider that served it. Both parts are asked for:
 * two providers can offer the same model id at different windows, and a session records
 * which of them answered. Consults every on-disk catalog pi keeps, in order.
 */
export function piContextWindow(model: string, provider: string | null, agentDir = piAgentDir()): number | null {
  const files: { path: string; parse: (p: unknown) => Map<string, Map<string, number>> | null }[] = [
    { path: join(agentDir, "models.json"), parse: modelsJsonCatalog },
    { path: join(agentDir, "commandcode-models.json"), parse: commandCodeCatalog },
    { path: join(agentDir, "models-store.json"), parse: modelsStoreCatalog },
  ];
  for (const file of files) {
    const catalog = readCatalog(file.path, file.parse);
    if (catalog === null) continue;
    const byId = provider === null ? undefined : catalog.byProvider.get(provider);
    if (byId === undefined) continue;
    if (byId.has(model)) return byId.get(model) ?? null;
    // provider present but model absent here: a later catalog may still list it
  }
  return null;
}

/** The cache is process-wide; tests point it at another directory. */
export function forgetPiModels(): void { cache.clear(); }
