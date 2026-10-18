/** Validate fork release metadata before publishing. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseNotes } from "./release-notes.ts";
import { SUMMARIES_FILE } from "./release-summary.ts";

const root = resolve(import.meta.dir, "..");
/** Release metadata (version sources, CHANGELOG section, patch notes in every language) as the Release run reads it. */
export function metadataProblems(read: (path: string) => string, version: string): string[] {
  try {
    releaseNotes(version, version, read("herdr-plugin.toml"), read("CHANGELOG.md"), read(SUMMARIES_FILE));
    return [];
  } catch (error) {
    return [`${(error as Error).message}. A release PR bumps package.json and herdr-plugin.toml, cuts the CHANGELOG.md section and writes ${SUMMARIES_FILE} (docs/development.md#releasing).`];
  }
}

function git(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, out: result.stdout.toString() };
}

export interface Verdict {
  /** null when the tree is not a release */
  version: string | null;
  problems: string[];
}

/**
 * Every problem of the release at `cwd`'s HEAD; `publishing` is the Release run itself. `base` is the
 * commit CI compares with: when it already carries this version, HEAD is a change merged between a
 * release PR and its Release run, not the release, and passes. A base that cannot be read is ignored.
 */
export function check(cwd: string, publishing: boolean, base?: string): Verdict {
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");
  const version = (JSON.parse(read("package.json")) as { version: string }).version;
  const tags = git(cwd, "tag", "--list").out.split("\n").filter(Boolean);
  if (!publishing && tags.includes(`fork-v${version}`)) return { version: null, problems: [] };
  const before = base && !publishing ? git(cwd, "show", `${base}:package.json`) : null;
  if (before?.ok && (JSON.parse(before.out) as { version: string }).version === version) return { version: null, problems: [] };

  return {
    version,
    problems: metadataProblems(read, version),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const publishing = args[0] === "--release";
  const base = args[0] === "--base" ? args[1] : undefined;
  if (base && !git(root, "show", `${base}:package.json`).ok) console.log(`::warning::Cannot read package.json at --base ${base}; checking HEAD as a release.`);
  const verdict = check(root, publishing, base || undefined);
  if (publishing && verdict.version !== args[1]) verdict.problems.unshift(`package.json version ${verdict.version} is not the requested ${args[1] ?? "(none)"}.`);
  if (verdict.version === null) console.log("Not a release (package.json's version is tagged, or the base already has it): nothing to check.");
  for (const problem of verdict.problems) console.error(`::error::${problem}`);
  if (verdict.problems.length > 0) process.exit(1);
  if (verdict.version !== null) console.log(`Release ${verdict.version}: release metadata are in order.`);
}
