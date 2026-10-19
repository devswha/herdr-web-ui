import type { ConversationMetadata, ConversationResponse } from "../shared/protocol.ts";
import type { OmpCatalogModel } from "./omp-catalog.ts";

/**
 * The model and reasoning effort an agent's own screen states before its first message, when no
 * transcript records them yet. Only a line in the agent's own layout is read, and a model is
 * given the id its transcript will record only where the screen's name maps to it by the
 * vendor's regular rule (src/lib/modelName.ts); anything else stays unknown rather than guessed.
 * Captured live 2026-10-14: Claude Code 2.1.296, Codex 0.162.1, gjc 0.17.7; 2026-10-19: omp 18.11.1.
 */
type Screen = Pick<ConversationMetadata, "model" | "reasoning_effort">;
const NOTHING: Screen = { model: null, reasoning_effort: null };

const CLAUDE_FAMILY = "opus|sonnet|haiku|fable|mythos";
const VERSION = "[1-9]\\d?";
const EFFORT = "none|minimal|low|medium|high|xhigh|max";

function lastMatch(lines: string[], pattern: RegExp): RegExpExecArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match) return match;
  }
  return null;
}

/** `▝▜██████▀  Haiku 5.5 · Claude Max`, the line under `Claude Code v…`. */
function claudeScreen(lines: string[]): Screen {
  const title = lastMatch(lines, /Claude Code v\d/u);
  if (!title) return NOTHING;
  const named = new RegExp(`(?:^|\\s)(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))? · `, "iu").exec(lines[lines.indexOf(title.input) + 1] ?? "");
  if (!named) return NOTHING;
  return { model: `claude-${named[1]!.toLowerCase()}-${named[2]}${named[3] === undefined ? "" : `-${named[3]}`}`, reasoning_effort: null };
}

/** `  GPT-6-Luna medium fast · /folder`, the status line under the composer. */
function codexScreen(lines: string[]): Screen {
  if (!lines.some((line) => line.includes("OpenAI Codex (v"))) return NOTHING;
  const found = lastMatch(lines, new RegExp(`^\\s*(GPT-[\\w.-]+) (${EFFORT})(?: \\w+)? · `, "u"));
  return found ? { model: found[1]!.toLowerCase(), reasoning_effort: found[2]! } : NOTHING;
}

/** ` ⬢ opus-5.5 · ◉ xhigh · 1.5% / …`, the status line over the composer. */
function gjcScreen(lines: string[]): Screen {
  const found = lastMatch(lines, new RegExp(`⬢ (\\S+) · ◉ (${EFFORT})(?: |$)`, "u"));
  if (!found) return NOTHING;
  const claude = new RegExp(`^(${CLAUDE_FAMILY})-(${VERSION})(?:\\.(0|${VERSION}))?$`, "u").exec(found[1]!);
  const model = claude ? `claude-${claude[1]}-${claude[2]}${claude[3] === undefined ? "" : `-${claude[3]}`}` : found[1]!;
  return { model, reasoning_effort: found[2]! };
}

/**
 * omp's three symbol presets (unicode, nerd, ascii; `theme/symbols.ts` of its TUI): the icon a
 * model segment leads with, and each thinking level as drawn. A compact segment draws the level's
 * first word where the icon would be and no level after the name.
 */
const OMP_MODEL_ICONS: Record<string, true> = { "⬢": true, "\uec19": true, "[M]": true };
const OMP_LEVELS: Record<string, string> = {
  "○ min": "minimal", "◔ low": "low", "◑ med": "medium", "◒ high": "high", "◕ xhigh": "xhigh", "◉ max": "max", "⦸ off": "off", "⟳ auto": "auto",
  "\u{F0A9E} min": "minimal", "\u{F0A9F} low": "low", "\u{F0AA1} med": "medium", "\u{F0AA3} high": "high", "\u{F0AA5} xhi": "xhigh", "\u{F06D} max": "max", "\uf05e off": "off", "\u{F074} auto": "auto",
  "[min]": "minimal", "[low]": "low", "[med]": "medium", "[high]": "high", "[xhi]": "xhigh", "[max]": "max", "[ ] off": "off", "[~] auto": "auto",
};
const OMP_LEVEL_GLYPHS: Record<string, string> = Object.fromEntries(Object.entries(OMP_LEVELS).map(([drawn, level]) => [drawn.split(" ")[0]!, level]));
/** After the name: the fast and advisor marks, then the level behind the presets' dot. */
const OMP_LEVEL_TAIL = new RegExp(`^(?: \\S+){0,2}?(?: · | - )(${Object.keys(OMP_LEVELS).map((drawn) => drawn.replace(/[[\]]/gu, "\\$&")).join("|")})(?=\\s|$)`, "u");

/**
 * ` π > ⟳ Opus 5.5 > 🗑 project ▶──2%──┃──1M─`, the status line over omp's composer. It names the
 * session's live model by its catalog name (a leading `Claude ` dropped), so a name is taken only
 * when it follows a model icon or level glyph, is followed by the line's end or a mark rather
 * than more of a name (a word, a number, a bracket: `Opus 5.5 (1M)` is not `Opus 5.5`), and
 * names one id in the pane's catalog: the id omp's transcript will record. A line naming two
 * models names none.
 */
function ompScreen(lines: string[], catalog: readonly OmpCatalogModel[]): Screen {
  const ids = new Map<string, string | null>();
  for (const model of catalog) {
    const name = model.name.startsWith("Claude ") ? model.name.slice(7) : model.name;
    ids.set(name, ids.has(name) && ids.get(name) !== model.id ? null : model.id);
  }
  // The captured box composer owns its top status border. Content rows start with a vertical
  // border; text below its bottom border, including pasted model segments, is not status.
  let bottom = lines.length - 1;
  while (bottom >= 0 && !/^\s*╰[─━]/u.test(lines[bottom]!)) bottom--;
  if (bottom < 0) return NOTHING;
  for (let index = bottom - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (/^\s*[│┃╰]/u.test(line) || !/[─━]{2,}|▶[─━]/u.test(line)) continue;
    const lead = line.trimStart().split(/\s/u)[0]!;
    if (lead !== "π" && !Object.hasOwn(OMP_MODEL_ICONS, lead) && !Object.hasOwn(OMP_LEVEL_GLYPHS, lead)) continue;
    const named: (Screen | null)[] = [];
    for (const [name, id] of ids) {
      for (let at = line.indexOf(` ${name}`); at >= 0; at = line.indexOf(` ${name}`, at + 1)) {
        const rest = line.slice(at + 1 + name.length);
        const icon = line.slice(0, at).split(" ").at(-1)!;
        const glyph = Object.hasOwn(OMP_LEVEL_GLYPHS, icon) ? OMP_LEVEL_GLYPHS[icon] : undefined;
        if (!/^(?:\s*$|\s+[^\s\p{L}\p{N}\p{Ps}])/u.test(rest) || (glyph === undefined && !Object.hasOwn(OMP_MODEL_ICONS, icon))) continue;
        const tail = glyph === undefined ? OMP_LEVEL_TAIL.exec(rest) : null;
        named.push(id === null ? null : { model: id, reasoning_effort: glyph ?? (tail ? OMP_LEVELS[tail[1]!]! : null) });
      }
    }
    // This border owns the composer even if its current model is unknown. Older status-like
    // lines above it must not fill in a model the current border did not name.
    if (named.length === 0) return NOTHING;
    const first = named[0] ?? null;
    return first !== null && named.every((screen) => screen?.model === first.model && screen.reasoning_effort === first.reasoning_effort) ? first : NOTHING;
  }
  return NOTHING;
}

const SCREENS: Partial<Record<ConversationResponse["source"], (lines: string[], ompCatalog: readonly OmpCatalogModel[]) => Screen>> = {
  "claude-transcript": claudeScreen,
  "codex-transcript": codexScreen,
  "gjc-transcript": gjcScreen,
  "omp-transcript": ompScreen,
};

export function readsStartScreen(source: ConversationResponse["source"]): boolean {
  return SCREENS[source] !== undefined;
}

/** `ompCatalog`: the catalog of the pane's omp (omp-catalog.ts), which omp's screen is read against. */
export function startScreenMetadata(source: ConversationResponse["source"], screen: string, ompCatalog: readonly OmpCatalogModel[] = []): Screen {
  return SCREENS[source]?.(screen.split("\n"), ompCatalog) ?? NOTHING;
}
