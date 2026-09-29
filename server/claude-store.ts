/**
 * Where Claude Code keeps a session's transcript: `~/.claude/projects/<project>/<session>.jsonl`.
 *
 * <project> is Claude's own encoding of the directory it started in (read from Claude Code
 * 2.1.284): every character that is not an ASCII letter or digit becomes `-`, and a name longer
 * than 200 characters keeps its first 200 plus `-` and a base-36 hash of the whole path. So
 * `my_project`, `example.com`, `.dotfiles`, `My Project` and a Korean folder all differ from a
 * plain `/` → `-` swap.
 *
 * The directory is only the fast path. The pane's cwd need not be the one Claude started in, and
 * Claude may change its encoding again, so a miss looks the session id up in every project: the
 * id is a UUID herdr reports, so at most one file answers to it.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_PROJECT_NAME = 200;

/** Java's String.hashCode, which Claude Code uses for the suffix of a long name. */
function stringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash << 5) - hash + text.charCodeAt(i) | 0;
  return hash;
}

export function claudeProjectDir(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

/** Only an absent path is a miss: an unreadable store is an error to report, not an empty one. */
function absent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch (error) { if (absent(error)) return false; throw error; }
}

/** Store + session id → the file a project scan found it in; checked again on every use. */
const found = new Map<string, string>();

export function forgetClaudeSessions(): void {
  found.clear();
}

/**
 * The transcript of `session` (a UUID, validated by the caller): under the project of each cwd
 * in turn, else in whichever project holds it. Null when no project does (a session that has not
 * written its first message yet).
 */
export function claudeTranscriptFile(home: string, session: string, cwds: readonly (string | null | undefined)[]): string | null {
  const projects = join(home, ".claude", "projects");
  const file = `${session}.jsonl`;
  for (const cwd of cwds) {
    if (!cwd) continue;
    const path = join(projects, claudeProjectDir(cwd), file);
    if (isFile(path)) return path;
  }
  const key = `${projects}\0${session}`;
  const known = found.get(key);
  if (known !== undefined && isFile(known)) return known;
  found.delete(key);
  let entries: string[];
  try { entries = readdirSync(projects); } catch (error) { if (absent(error)) return null; throw error; }
  for (const entry of entries) {
    const path = join(projects, entry, file);
    if (isFile(path)) { found.set(key, path); return path; }
  }
  return null;
}
