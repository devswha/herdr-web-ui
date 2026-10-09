// The file viewer's numbered text (components/FileViewer.tsx): a text file's lines as markup,
// colored by highlight.js where it knows the language.
import type { HLJSApi } from "highlight.js";

/** Files known by their name, not an extension, as highlight.js names their language. */
const FILE_NAMES: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".profile": "bash",
  ".zshrc": "bash",
  ".zprofile": "bash",
  ".zshenv": "bash",
};

/**
 * The language to ask highlight.js for, from the file's name: its extension, which highlight.js
 * takes as an alias (`ts`, `py`, `rs`, `yml`), or a known name. null shows the text plain without
 * loading highlight.js; one it does not know stays plain too.
 */
export function codeLanguage(name: string): string | null {
  const lower = name.toLowerCase();
  const known = FILE_NAMES[lower];
  if (known !== undefined) return known;
  const dot = lower.lastIndexOf(".");
  // no extension, or a dotfile not named above
  if (dot <= 0 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

/**
 * Languages left plain. highlight.js's Markdown grammar takes time that grows with the cube of some
 * text (8 KB of `[a](` takes seconds), and the viewer colors on the page's own thread, so an odd
 * Markdown file would freeze the tab.
 */
const PLAIN_LANGUAGES = ["markdown"];

/** Whether the viewer colors text in `language`: highlight.js knows it, under any of its names, and it is not left plain. */
export function highlightable(hljs: HLJSApi, language: string): boolean {
  const known = hljs.getLanguage(language);
  return known !== undefined && !PLAIN_LANGUAGES.some((plain) => hljs.getLanguage(plain) === known);
}

/** Text as markup, for text highlight.js did not mark up. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/** Line ends as `\n` alone: a `\r` left at a line's end would draw in the line. */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Markup cut at its newlines. A span may run over several lines (a block comment, a template
 * string): each line closes the spans still open at its end and opens them again at the start of
 * the next, so every line is markup of its own. The empty line after a final newline is left out,
 * as an editor shows it.
 */
export function splitMarkupLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  let last = 0;
  for (const match of html.matchAll(/<span[^>]*>|<\/span>|\n/g)) {
    line += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else {
      if (match[0] === "</span>") open.pop();
      else open.push(match[0]);
      line += match[0];
    }
  }
  line += html.slice(last);
  if (lines.length === 0 || line.replace(/<[^>]*>/g, "") !== "") lines.push(line);
  return lines;
}

/**
 * The numbered view's markup: a block per line, each holding its own newline, so a long line wraps
 * under its own text and a copy is the text as it was, without the numbers (drawn by CSS).
 */
export function numberedLinesHtml(lines: string[]): string {
  return lines.map((line) => `<span class="file-viewer-line">${line}\n</span>`).join("");
}
