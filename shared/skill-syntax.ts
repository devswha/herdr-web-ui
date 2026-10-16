/** Static invocation syntax, safe to import as a value in the browser. */
export interface SkillSyntax {
  skillTriggers: readonly ("/" | "$")[];
  inline: readonly ("/" | "$")[];
  namespaced: boolean;
  /** `{bare}` is the command name without its `skill:` namespace. */
  chipForms: readonly string[];
}

export const DEFAULT_SKILL_SYNTAX: SkillSyntax = {
  skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [],
};

export const SKILL_SYNTAX: Readonly<Record<string, SkillSyntax>> = {
  omo: { skillTriggers: ["/", "$"], inline: ["$"], namespaced: true, chipForms: ["$skill:{bare}", "[skill: {bare}]"] },
  codex: { skillTriggers: ["$"], inline: ["/", "$"], namespaced: false, chipForms: [] },
  claude: { skillTriggers: ["/"], inline: ["/"], namespaced: false, chipForms: [] },
  pi: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  omp: { skillTriggers: ["/"], inline: ["/"], namespaced: true, chipForms: [] },
  gjc: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  devin: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  hermes: { skillTriggers: ["/"], inline: [], namespaced: true, chipForms: [] },
  opencode: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  grok: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
  agy: { skillTriggers: ["/"], inline: [], namespaced: false, chipForms: [] },
};

export function skillSyntax(agent: string | null | undefined): SkillSyntax {
  return agent != null && Object.hasOwn(SKILL_SYNTAX, agent)
    ? SKILL_SYNTAX[agent] ?? DEFAULT_SKILL_SYNTAX
    : DEFAULT_SKILL_SYNTAX;
}
