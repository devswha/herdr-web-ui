/**
 * Fixed sleeps: waits that pass a set time instead of waiting for what they are after
 * (AGENTS.md: "Wait with bounded polls and deadlines, never fixed sleeps"). A fixed sleep is
 * too short on a slow CI runner and too long everywhere else.
 *
 * Not counted:
 * - the pause between reads of a loop bounded by a deadline or a try count
 *   (`while (!done() && Date.now() < deadline) await Bun.sleep(25)`, `for (let i = 0; i < 40 && …; i++)`,
 *   or a loop whose body throws, asserts, returns or breaks on a deadline);
 * - a timeout raced against the real event (`Promise.race([event, Bun.sleep(ms)])`);
 * - `setTimeout(resolve, 0)`, which yields a turn rather than waiting;
 * - a wait that is fixed on purpose and says so on its line or the line above:
 *   `// fixed wait: <why>` (proving that nothing arrives, a settle gap herdr needs).
 *
 * scripts/conventions.test.ts holds every file to its count in scripts/fixed-sleeps.json, which
 * may only shrink. `bun scripts/fixed-sleeps.ts` prints the current counts.
 */
import { files, lineOf, read, stripComments } from "./source-scan.ts";

const SLEEP = /\bBun\.sleep(?:Sync)?\s*\(|\bnew Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*(?:window\.|globalThis\.)?setTimeout\(\s*\1\s*,(?!\s*0\s*\))/g;
const BOUND = /Date\.now\(\)|performance\.now\(\)|deadline|\b\w+\s*<=?\s*[\w.]+/i;
const MARKER = /\/\/\s*fixed wait:/;

/** The files the rule covers. Media takes are timed by hand (scripts/AGENTS.md, MEDIA). */
export const sleepFiles = (): string[] => files("{server,src,shared,scripts,site,telemetry}/**/*.{ts,tsx,mjs,js}")
  .filter((file) => !file.startsWith("scripts/film/") && !file.startsWith("scripts/readme-media/") && file !== "scripts/fixed-sleeps.ts" && file !== "scripts/conventions.test.ts");

/** Whether the innermost loop around `at` (within its function) is bounded. `code` has comments and strings blanked. */
function inBoundedLoop(code: string, at: number): boolean {
  for (let from = at; ;) {
    let open = -1;
    for (let i = from - 1, depth = 0; i >= 0; i--) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") { if (depth === 0) { open = i; break; } depth -= 1; }
    }
    if (open < 0) return false;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < code.length; close++) depth += code[close] === "{" ? 1 : code[close] === "}" ? -1 : 0;
    const head = code.slice(code.lastIndexOf("\n", open - 1) + 1, open).trim();
    const body = code.slice(open, close);
    const doWhile = /(?:^|[\s;}])do$/.test(head) ? /^\s*while\s*\(([^\n]*)/.exec(code.slice(close))?.[1] ?? "" : null;
    if (doWhile !== null || /\b(?:while|for)\s*\(/.test(head)) {
      return BOUND.test(doWhile ?? head) || (/Date\.now\(\)|performance\.now\(\)|deadline/i.test(body) && /\b(?:throw|return|break|assert|expect)\b/.test(body));
    }
    // a function body: the loop, if any, would be inside it
    if (/=>$|\)\s*(?::[^{]*)?$/.test(head) && !/\b(?:if|switch|catch|with)\s*\(/.test(head)) return false;
    from = open;
  }
}

/** The fixed sleeps in one file, as `file:line: text`. */
export function fixedSleeps(file: string, text = read(file)): string[] {
  const code = stripComments(text, { strings: true });
  const lines = text.split("\n");
  const found: string[] = [];
  for (const match of code.matchAll(SLEEP)) {
    const line = lineOf(code, match.index);
    const codeLine = code.split("\n")[line - 1]!;
    if (/\bPromise\.race\s*\(/.test(codeLine)) continue;
    if (MARKER.test(lines[line - 1]!) || MARKER.test(lines[line - 2] ?? "")) continue;
    const before = codeLine.slice(0, match.index - (code.lastIndexOf("\n", match.index) + 1));
    if (/^\s*(?:while|for)\s*\(/.test(before) && BOUND.test(before)) continue;
    if (inBoundedLoop(code, match.index)) continue;
    found.push(`${file}:${line}: ${lines[line - 1]!.trim().slice(0, 160)}`);
  }
  return found;
}

/** Fixed-sleep counts per file, files with none left out. */
export function fixedSleepCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of sleepFiles()) {
    const count = fixedSleeps(file).length;
    if (count) counts[file] = count;
  }
  return counts;
}

if (import.meta.main) console.log(JSON.stringify(fixedSleepCounts(), null, 2));
