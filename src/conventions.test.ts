import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, files as scan, read, repo } from "../scripts/source-scan.ts";

// Client conventions from AGENTS.md and src/AGENTS.md that used to be prose only. Each failure
// says what to change; server rules are in server/conventions.test.ts, repo-wide ones in
// scripts/conventions.test.ts.

/** The value of every declaration (`prop: value;`), comments and quoted strings removed; selectors and at-rule preludes are left out. */
function declarationValues(css: string): string[] {
  const values: string[] = [];
  for (const [, piece, end] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^;{}]*)([;{}])/g)) {
    if (end === "{") continue;
    const colon = piece!.indexOf(":");
    if (colon < 0 || piece!.trim().startsWith("@")) continue;
    values.push(piece!.slice(colon + 1).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "\"\"").replace(/\s+/g, " ").trim());
  }
  return values;
}

/** Color literals in a declaration value: hex, color functions and the common named colors. `color-mix()` of tokens is fine. */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(|(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|maroon|olive|lime|aqua|fuchsia|cyan|magenta)(?![\w-])/;

describe("component CSS", () => {
  // The light theme and the opt-in palettes are only token overrides in src/styles.css: a literal
  // in a component stylesheet stays the same in every theme, and `!important` beats the order the
  // primitives rely on (src/AGENTS.md).
  it("uses tokens only: no color literal and no !important outside src/styles.css", () => {
    const offenders = scan("src/**/*.css").filter((file) => file !== "src/styles.css").flatMap((file) => {
      const css = read(file);
      return [
        ...declarationValues(css).filter((value) => COLOR_LITERAL.test(value)).map((value) => `${file}: ${value}`),
        ...(css.replace(/\/\*[\s\S]*?\*\//g, "").match(/!\s*important/g) ?? []).map(() => `${file}: !important`),
      ];
    });
    fail(offenders, "Component CSS takes colors from the tokens in src/styles.css (var(--…), or color-mix() of tokens) and wins by order at the same specificity, never by !important. Add a token to src/styles.css (both themes) and DESIGN.md if none fits.");
  });

  it("reads declaration values, not selectors or comments", () => {
    expect(declarationValues("#main .a:hover { color: var(--text); white-space: nowrap }")).toEqual(["var(--text)", "nowrap"]);
    expect(declarationValues("/* color: #fff; */ .a { content: \"#fff black\"; }")).toEqual(["\"\""]);
    expect(declarationValues(".a { border: 1px solid #2a2621 }").filter((value) => COLOR_LITERAL.test(value))).toEqual(["1px solid #2a2621"]);
    expect(COLOR_LITERAL.test("color-mix(in srgb, var(--accent) 25%, transparent)")).toBe(false);
    expect(COLOR_LITERAL.test("pulse-green 1s steps(2)")).toBe(false);
  });
});

/** Custom properties declared in the top-level rules whose selector is exactly `selector` (rules nested in @media are skipped). */
function tokens(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let at = 0; at < text.length;) {
    const open = text.indexOf("{", at);
    if (open < 0) break;
    let close = open + 1;
    for (let depth = 1; depth > 0 && close < text.length; close++) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
    if (text.slice(at, open).replace(/\s+/g, " ").trim() === selector) {
      for (const [, name, value] of text.slice(open + 1, close - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found.set(name!, value!.replace(/\s+/g, " ").trim());
    }
    at = close;
  }
  return found;
}

describe("DESIGN.md", () => {
  // DESIGN.md's token tables say they are literal CSS. Each row is `| … | `--token` | `value` | … |`;
  // the cell after the token is the base (`:root`) value, and a second literal cell is the light or
  // compact one, by its column header. A cell that is not one literal (`same`, `—`, prose) is not compared.
  it("lists the same token values as src/styles.css", () => {
    const css = read("src/styles.css");
    const base = tokens(css, ":root");
    const second = { light: tokens(css, "[data-theme=\"light\"]"), compact: tokens(css, "[data-density=\"compact\"]") };
    const literal = (cell: string | undefined): string | null => cell !== undefined && /^`[^`]+`$/.test(cell) ? cell.slice(1, -1).replace(/\s+/g, " ").trim() : null;
    const offenders: string[] = [];
    let compared = 0;
    let header: string[] = [];
    for (const [index, line] of read("DESIGN.md").split("\n").entries()) {
      if (!line.startsWith("|")) { header = []; continue; }
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (!header.length) { header = cells; continue; }
      const at = cells.findIndex((cell) => /^`--[\w-]+`$/.test(cell));
      if (at < 0) continue;
      const token = cells[at]!.slice(1, -1);
      const where = `DESIGN.md:${index + 1} ${token}`;
      const value = literal(cells[at + 1]);
      if (value !== null) {
        compared += 1;
        if (base.get(token) !== value) offenders.push(`${where}: DESIGN.md says ${value}, :root has ${base.get(token) ?? "nothing"}`);
      }
      const other = literal(cells[at + 2]);
      if (other === null) continue;
      const column = header[at + 2] ?? "";
      const block = /light/i.test(column) ? second.light : /compact/i.test(column) ? second.compact : null;
      if (block === null) { offenders.push(`${where}: no rule for the column "${column}"; teach this test which src/styles.css block it describes`); continue; }
      compared += 1;
      const actual = block.get(token) ?? base.get(token);
      if (actual !== other) offenders.push(`${where} (${column}): DESIGN.md says ${other}, src/styles.css has ${actual ?? "nothing"}`);
    }
    fail(offenders, "DESIGN.md's token tables and src/styles.css disagree. Change both together: the token's value in src/styles.css (`:root`, `[data-theme=\"light\"]` or `[data-density=\"compact\"]`) and its row in DESIGN.md.");
    // a reformatted table must not quietly turn this test off
    expect(compared).toBeGreaterThan(150);
  });
});

/**
 * The icon files a browser and the service worker cache, their `?v=` query and the CACHE_NAME
 * they last shipped with. Browsers and public/sw.js keep an icon by its URL, so changed icon bytes
 * reach an installed app only under a new query and a new cache.
 *
 * When icon files change: pick a new query, use it on every icon URL in index.html,
 * public/manifest.webmanifest and public/sw.js, give public/sw.js a new CACHE_NAME, and add an
 * entry here with the new hash. Keep the old entries: a query or a cache name is never reused.
 */
const ICON_VERSIONS: Record<string, { sha256: string; cacheName: string }> = {
  ram1: { sha256: "ed82342db3ec3ed2151ddd2d0d77805233e9251758e29972b4f09aa95602041e", cacheName: "herdr-web-ui-v4-ram" },
};
const CURRENT_ICONS = "ram1";

function iconFiles(): string[] {
  return ["public/favicon.ico", "public/favicon.png", "public/apple-touch-icon.png", ...readdirSync(join(repo, "public/icons")).map((name) => `public/icons/${name}`)].sort();
}

function iconHash(): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of iconFiles()) hasher.update(`${file}\0`).update(readFileSync(join(repo, file))).update("\0");
  return hasher.digest("hex");
}

describe("icon cache", () => {
  const sw = read("public/sw.js");
  const cacheName = /const CACHE_NAME = "([^"]+)"/.exec(sw)?.[1];
  const queries = ["index.html", "public/manifest.webmanifest", "public/sw.js"].flatMap((file) =>
    [...read(file).matchAll(/["'](\/[\w./-]+\.(?:png|ico|svg|webp))\?v=([^"'&]+)["']/g)].map(([, url, query]) => ({ file, url: url!, query: query! })));

  it("gives every icon URL the same ?v= query, the current one", () => {
    expect(queries.filter((entry) => entry.file === "index.html").length).toBeGreaterThanOrEqual(3);
    fail(queries.filter((entry) => entry.query !== CURRENT_ICONS).map((entry) => `${entry.file}: ${entry.url}?v=${entry.query}`),
      `Every icon URL in index.html, public/manifest.webmanifest and public/sw.js carries ?v=${CURRENT_ICONS} (CURRENT_ICONS in src/conventions.test.ts). Bump them all together.`);
  });

  it("moves the query and CACHE_NAME together when the icon files change", () => {
    const current = ICON_VERSIONS[CURRENT_ICONS];
    if (!current) throw new Error(`CURRENT_ICONS (${CURRENT_ICONS}) has no entry in ICON_VERSIONS in src/conventions.test.ts.`);
    const hash = iconHash();
    if (hash !== current.sha256) {
      throw new Error(`The icon files (${iconFiles().join(", ")}) changed, but ?v=${CURRENT_ICONS} still names the old ones. Pick a new query, set it on every icon URL in index.html, public/manifest.webmanifest and public/sw.js, give public/sw.js a new CACHE_NAME, then add { sha256: "${hash}", cacheName: <the new CACHE_NAME> } under the new query to ICON_VERSIONS in src/conventions.test.ts and point CURRENT_ICONS at it. Keep the old entries.`);
    }
    const reused = Object.entries(ICON_VERSIONS).filter(([query, entry]) => query !== CURRENT_ICONS && entry.cacheName === cacheName);
    fail(reused.map(([query]) => `CACHE_NAME "${cacheName}" is the cache of the icons under ?v=${query}`),
      "public/sw.js needs a new CACHE_NAME for the new icons: an installed app keeps serving the old icons out of the old cache.");
  });
});

describe("UI wording", () => {
  // "Session" means the herdr server session or an agent's history; the dialog that makes a
  // workspace says "New workspace" (AGENTS.md).
  it("says New workspace, never New session", () => {
    const offenders = [...scan("src/**/*.{ts,tsx}"), ...scan("site/**/*.{ts,tsx,html}"), "index.html"]
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => read(file).split("\n").flatMap((line, index) =>
        /^\s*(?:\/\/|\/?\*)/.test(line) || !/\bNew [Ss]ession\b/.test(line) ? [] : [`${file}:${index + 1}: ${line.trim()}`]));
    fail(offenders, "UI text says \"New workspace\", not \"New session\" (AGENTS.md, UI wording). Change the string and its i18n entries in src/lib/i18n.*.ts.");
  });
});
