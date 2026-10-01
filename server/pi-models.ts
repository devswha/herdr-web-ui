import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The context window a pi model runs in.
 *
 * A pi transcript records what a request filled but never the window it filled, so the
 * percentage the composer's ring shows cannot come from the file. pi answers it from its
 * own model registry, which lives in the process (`getBuiltinModel`, compiled into the
 * bundle) and is refreshed over the network, so a reader of the transcript cannot duplicate
 * it. What it can read is the one catalog pi does keep on disk: the user's own
 * `models.json`, the file that defines every custom provider. `~/.pi/agent/models.json`
 * is pi's default location, moved by `PI_CODING_AGENT_DIR`.
 *
 * So this resolves what that file states and nothing else. A model pi knows from its
 * built-in registry, or a provider whose entry omits `contextWindow`, stays unresolved and
 * the ring is not drawn: guessing a window would draw a percentage the user cannot tell
 * from pi's own. pi's footer does the same, showing `?` in place of a number.
 */

/** The file's own spelling: `providers` by id, each with a list of models. */
type PiModel = { id?: unknown; contextWindow?: unknown };
type PiProvider = { models?: unknown };
type PiCatalog = { providers?: Record<string, PiProvider> };

/** pi strips a BOM and `//` comments before parsing this file, so a commented file still loads. */
function parse(text: string): unknown {
  const stripped = text.replace(/^\uFEFF/, "").replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : "")).replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
  try { return JSON.parse(stripped); } catch { return null; }
}

/**
 * A provider's models by id. A provider may re-state `contextWindow` at its own level, the
 * way a default applies to every model under it; a model that says otherwise wins.
 */
function windowsOf(providerId: string, provider: PiProvider): Map<string, number> {
  const shared = (provider as { contextWindow?: unknown }).contextWindow;
  const list: PiModel[] = Array.isArray(provider.models) ? provider.models as PiModel[] : [];
  const models = new Map<string, number>();
  for (const model of list) {
    if (typeof model.id !== "string") continue;
    const window = typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : typeof shared === "number" && Number.isFinite(shared) && shared > 0 ? shared : null;
    if (window !== null) models.set(model.id, window);
  }
  const empty = models.size === 0;
  return empty ? new Map() : models;
}

/** `models.json` read once per change: a conversation is re-read on every poll. */
let cache: { path: string; signature: string; providers: Map<string, Map<string, number>> } | null = null;

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env["PI_CODING_AGENT_DIR"];
  return typeof dir === "string" && dir.length > 0 ? (dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir) : join(homedir(), ".pi", "agent");
}

/**
 * The window a model runs in, by the provider that served it. Both parts are asked for:
 * two providers can offer the same model id at different windows, and a session records
 * which of them answered.
 */
export function piContextWindow(model: string, provider: string | null, agentDir = piAgentDir()): number | null {
  let path: string;
  try { path = join(agentDir, "models.json"); } catch { return null; }
  let signature: string;
  try { const stat = statSync(path); signature = `${stat.mtimeMs}:${stat.size}`; } catch { return null; }
  if (cache === null || cache.path !== path || cache.signature !== signature) {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch { return null; }
    const catalog = parse(text) as PiCatalog | null;
    const providers = new Map<string, Map<string, number>>();
    if (catalog !== null && typeof catalog === "object" && catalog.providers !== undefined && catalog.providers !== null) {
      for (const [id, provider] of Object.entries(catalog.providers)) {
        if (provider === null || typeof provider !== "object") continue;
        providers.set(id, windowsOf(id, provider));
      }
    }
    cache = { path, signature, providers };
  }
  // an exact provider match only: a model id a second provider also serves, at another
  // window, must not borrow the first one's number
  const byId = provider === null ? undefined : cache.providers.get(provider);
  return byId?.get(model) ?? null;
}

/** The cache is process-wide; tests point it at another directory. */
export function forgetPiModels(): void { cache = null; }
