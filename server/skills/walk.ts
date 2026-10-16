import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SkillIgnore } from "../skill-ignore.ts";
import type { SlashCommand } from "../../shared/protocol.ts";

export interface WalkRules {
  readonly depth: "one" | "recursive";
  readonly looseMarkdown: "none" | "root" | "nested";
  readonly ignoreFiles: boolean;
  readonly requireDescription: boolean;
  readonly skipNames?: (name: string) => boolean;
}
export interface WalkedSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Reads only through the closing frontmatter delimiter, without reading the skill body. */
export function readFrontmatter(path: string): Readonly<Record<string, unknown>> | null {
  try {
    const fd = openSync(path, "r");
    let markdown = "";
    try {
      const chunks: Buffer[] = [];
      for (;;) {
        const chunk = Buffer.alloc(8192);
        const count = readSync(fd, chunk, 0, chunk.length, null);
        chunks.push(chunk.subarray(0, count));
        markdown = Buffer.concat(chunks).toString("utf8");
        if (!markdown.startsWith("---") && !markdown.startsWith("\uFEFF---")) return null;
        if (/\r?\n---(?:\s*\r?\n|$)/.test(markdown) || count < chunk.length) break;
      }
    } finally { closeSync(fd); }
    const header = markdown.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)?.[1];
    if (!header) return null;
    const fields: unknown = Bun.YAML.parse(header);
    return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? Object.fromEntries(Object.entries(fields)) : null;
  } catch { return null; /* missing, unreadable or malformed frontmatter */ }
}

export function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}
export function walkSkills(root: string, rules: WalkRules): WalkedSkill[] {
  const result: WalkedSkill[] = [];
  const ignore = new SkillIgnore();
  const ancestors = new Set<string>();
  const load = (path: string): void => {
    const fields = readFrontmatter(path) ?? {};
    if (rules.requireDescription && (typeof fields.description !== "string" || !fields.description.trim())) return;
    try {
      // The original one-level loaders use their permissive name parser and short body fallback.
      const markdown = rules.requireDescription ? "" : readFileSync(path, "utf8");
      const name = rules.requireDescription
        ? typeof fields.name === "string" && fields.name ? fields.name : basename(dirname(path))
        : skillName(markdown, basename(dirname(path)));
      result.push({ name, description: rules.requireDescription && typeof fields.description === "string" ? fields.description : description(markdown), path, fields });
    } catch { return; /* unreadable skill */ }
  };
  if (rules.depth === "one") {
    if (!existsSync(root)) return result;
    if (rules.ignoreFiles) {
      for (const filename of [".gitignore", ".ignore", ".fdignore"]) {
        try { ignore.add(readFileSync(join(root, filename), "utf8")); } catch { /* optional ignore file */ }
      }
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || rules.skipNames?.(entry.name)) continue;
      const directory = join(root, entry.name);
      try {
        if (statSync(directory).isDirectory() && !ignore.ignores(entry.name + "/")) load(join(directory, "SKILL.md"));
        else if (rules.looseMarkdown === "root" && entry.name.endsWith(".md") && statSync(directory).isFile() && !ignore.ignores(entry.name)) load(directory);
      } catch { continue; /* broken links or missing skill */ }
    }
    return result;
  }
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      const prefix = relative(root, directory).split(sep).join("/");
      for (const filename of rules.ignoreFiles ? [".gitignore", ".ignore", ".fdignore"] : []) {
        try { ignore.add(readFileSync(join(directory, filename), "utf8"), prefix ? `${prefix}/` : ""); }
        catch { continue; /* optional ignore file */ }
      }
      const entries = readdirSync(directory, { withFileTypes: true });
      const declared = join(directory, "SKILL.md");
      if (entries.some((entry) => entry.name === "SKILL.md") && !ignore.ignores(relative(root, declared).split(sep).join("/"))) {
        try {
          if (statSync(declared).isFile()) { load(declared); return; }
        } catch { /* a broken SKILL.md link does not hide other entries */ }
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || rules.skipNames?.(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          const relativePath = relative(root, path).split(sep).join("/");
          if (ignore.ignores(relativePath + (target.isDirectory() ? "/" : ""))) continue;
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md") && (rules.looseMarkdown === "root" ? directory === root : rules.looseMarkdown === "nested" && directory !== root)) load(path);
        } catch { continue; /* broken links and unreadable directories are skipped */ }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}

/** Existing one-level command mapping, kept separate from each agent's root selection. */
export function skills(root: string, source: SlashCommand["source"], options: { prefix?: string; trigger?: "$" } = {}): SlashCommand[] {
  return walkSkills(root, { depth: "one", looseMarkdown: "none", ignoreFiles: false, requireDescription: false }).map(({ name, description }) => ({
    name: options.prefix ? `${options.prefix}:${name}` : name, description, source, ...(options.trigger ? { trigger: options.trigger } : {}),
  }));
}

export function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  // Guard only the current ancestry: sibling links can expose different command namespaces.
  const ancestors = new Set<string>();
  const visit = (directory: string): void => {
    let canonical: string;
    try { canonical = realpathSync(directory); } catch { return; }
    if (ancestors.has(canonical)) return;
    ancestors.add(canonical);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        try {
          const target = statSync(path);
          if (target.isDirectory()) visit(path);
          else if (target.isFile() && entry.name.endsWith(".md")) {
            const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
            result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
          }
        } catch { continue; }
      }
    } finally { ancestors.delete(canonical); }
  };
  visit(root);
  return result;
}


/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
export function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      const target = join(root, entry.name);
      if (!statSync(target).isFile()) continue;
      markdown = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source });
  }
  return result;
}


/** The nearest repository boundary wins; the home directory is never a project ancestor. */
export function ancestorsToRepoRoot(cwd: string): string[] {
  const start = resolve(cwd);
  const home = resolve(process.env.HOME ?? "");
  if (start === home || home.startsWith(start.endsWith(sep) ? start : start + sep)) return [];
  const result: string[] = [];
  for (let directory = start; directory !== home && directory !== dirname(directory); directory = dirname(directory)) {
    result.push(directory);
    if (existsSync(join(directory, ".git"))) return result;
  }
  return [cwd];
}
