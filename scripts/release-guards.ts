/** Validate fork release metadata and the matching remote runtime before publishing. */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseNotes } from "./release-notes.ts";
import { SUMMARIES_FILE } from "../server/release-notes.ts";

const root = resolve(import.meta.dir, "..");
const MACHINES = "shared/machines.ts";

/**
 * What scripts/build-remote-bundle.ts packs from this tree: server/ and shared/ without tests,
 * node_modules (bun.lock, patches/) and the builder's own pins. dist/ is left out: a bridge's page
 * is never opened, the connection server's is. Docs and test fixtures are copied but never run.
 */
export const BUNDLE_PATHSPECS = ["server", "shared", "patches", "bun.lock", "scripts/build-remote-bundle.ts"];
export const bundleInput = (path: string): boolean => BUNDLE_PATHSPECS.some((spec) => path === spec || path.startsWith(`${spec}/`))
  && !path.endsWith(".test.ts") && !path.endsWith(".md") && !path.startsWith("server/fixtures/");
/** The Linux bundles carry the bun that builds them (process.execPath), so its pin in this workflow is a bundle input too. */
export const BUNDLE_WORKFLOW = ".github/workflows/remote-bundles.yml";
export const bunPins = (workflow: string): string => [...workflow.matchAll(/bun-version:\s*(\S+)/g)].map((match) => match[1]).join(" ");
/** package.json's fields that decide node_modules; its version changes in every release and decides nothing */
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "patchedDependencies", "overrides", "trustedDependencies"];
export const dependencies = (packageJson: string): string => {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  return JSON.stringify(DEPENDENCY_FIELDS.map((field) => parsed[field] ?? null));
};

export const bundleVersion = (machines: string): string => {
  const version = /^export const REMOTE_BUNDLE_VERSION = "(\d+)";$/m.exec(machines)?.[1];
  if (!version) throw new Error(`REMOTE_BUNDLE_VERSION not found in ${MACHINES}`);
  return version;
};

export interface BundleFacts {
  /** REMOTE_BUNDLE_VERSION in this tree */
  version: number;
  /** N of every fork-remote-vN tag */
  published: number[];
  /** bundle inputs that differ between the fork-remote-v<version> tag and this tree; null when that tag does not exist */
  changed: string[] | null;
  /** the Release run: the bundle this tree names must already be published */
  publishing: boolean;
}

/** Why this release would ship a remote bundle that does not match its own server, or none at all. */
export function bundleProblems({ version, published, changed, publishing }: BundleFacts): string[] {
  const latest = Math.max(0, ...published);
  const next = Math.max(version, latest) + 1;
  if (version < latest) return [`REMOTE_BUNDLE_VERSION is ${version} but fork-remote-v${latest} exists: raise it to ${next} in ${MACHINES}.`];
  if (changed === null) {
    return publishing ? [`fork-remote-v${version} is not published. Push the tag fork-remote-v${version} on this commit, wait for the Remote PC bundles workflow to publish it, then run Release again (docs/remote-pcs.md).`] : [];
  }
  if (changed.length === 0) return [];
  const shown = changed.slice(0, 10).join(", ") + (changed.length > 10 ? `, and ${changed.length - 10} more` : "");
  return [`The remote bundle's inputs changed since fork-remote-v${version} (${shown}), so remote PCs would keep the old server. Raise REMOTE_BUNDLE_VERSION in ${MACHINES} from ${version} to ${next} in the release PR (or, when it already merged, in a follow-up PR); after it merges, push fork-remote-v${next} on the merged commit and wait for the Remote PC bundles workflow before running Release (docs/development.md#releasing).`];
}

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

  const bundle = Number(bundleVersion(read(MACHINES)));
  const published = tags.flatMap((tag) => /^fork-remote-v(\d+)$/.exec(tag)?.[1] ?? []).map(Number);
  let changed: string[] | null = null;
  if (published.includes(bundle)) {
    const tag = `fork-remote-v${bundle}`;
    const diff = git(cwd, "diff", "--name-only", `${tag}^{commit}`, "HEAD", "--", ...BUNDLE_PATHSPECS);
    if (!diff.ok) throw new Error(`Cannot compare with ${tag}: fetch its commit first (git fetch --depth=1 origin tag ${tag}).`);
    changed = diff.out.split("\n").filter((path) => path && bundleInput(path));
    const tagged = git(cwd, "show", `${tag}^{commit}:package.json`);
    if (tagged.ok && dependencies(tagged.out) !== dependencies(read("package.json"))) changed.push("package.json dependencies");
    const workflow = git(cwd, "show", `${tag}^{commit}:${BUNDLE_WORKFLOW}`);
    let pins = "";
    try { pins = bunPins(read(BUNDLE_WORKFLOW)); } catch { /* no workflow in this tree */ }
    if (workflow.ok && bunPins(workflow.out) !== pins) changed.push(`${BUNDLE_WORKFLOW} bun-version`);
  }

  return {
    version,
    problems: [
      ...metadataProblems(read, version),
      ...bundleProblems({ version: bundle, published, changed, publishing }),
    ],
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
  if (verdict.version !== null) console.log(`Release ${verdict.version}: remote bundle and release metadata are in order.`);
}
