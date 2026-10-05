/**
 * The name a person calls a model by, for the composer's pill, or the id exactly as received.
 *
 * A name is never guessed. Only an id that matches one of the patterns below WHOLE gets one,
 * and each pattern is the vendor's own regular id-to-name rule:
 * - Anthropic: `claude-<family>-<major>[-<minor>]` is "Claude <Family> <major>[.<minor>]"
 *   (claude-opus-5-5 is Claude Opus 5.5, claude-sonnet-5 is Claude Sonnet 5, claude-haiku-4-5 is
 *   Claude Haiku 4.5). The pill draws it as Claude Code's own status line does, without the
 *   vendor word ("Opus 5.5"): the agent mark beside it and the agent's read name say whose it is.
 *   The same id behind the vendor's own provider prefix (`anthropic/claude-opus-5-5`, as pi and
 *   omo record it) is the same model.
 * - OpenAI: `gpt-<version>` is "GPT-<version>" (gpt-5.6 is GPT-5.6).
 * - Z.ai: `glm-<version>` is "GLM-<version>" (glm-5.3 is GLM-5.3).
 *
 * Everything else is drawn as the identifier it is: a dated snapshot (claude-haiku-4-5-20251001),
 * a tier or product word this file cannot name for certain (gpt-5.6-sol, gpt-5.6-sol-max), an
 * older id order (claude-3-5-sonnet), another provider's route to a model (bedrock/…), and every
 * vendor not listed. So no suffix is ever dropped: an id either reads whole as a name or is shown
 * whole. The raw id stays in the label's title either way.
 */
export interface ModelLabel {
  /** what the pill draws */
  text: string;
  /** false: `text` is the id as received, drawn in the identifier face */
  named: boolean;
}

const CLAUDE = /^(?:anthropic\/)?claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?$/u;
const GPT = /^gpt-(\d{1,2}(?:\.\d{1,2})?)$/u;
const GLM = /^glm-(\d{1,2}(?:\.\d{1,2})?)$/u;

export function modelLabel(id: string): ModelLabel {
  const claude = CLAUDE.exec(id);
  if (claude) {
    const family = claude[1]!;
    return { text: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] === undefined ? "" : `.${claude[3]}`}`, named: true };
  }
  const gpt = GPT.exec(id);
  if (gpt) return { text: `GPT-${gpt[1]}`, named: true };
  const glm = GLM.exec(id);
  if (glm) return { text: `GLM-${glm[1]}`, named: true };
  return { text: id, named: false };
}
