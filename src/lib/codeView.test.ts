import { describe, expect, it } from "bun:test";
import hljs from "./highlight.ts";
import { codeLanguage, escapeHtml, highlightable, normalizeNewlines, numberedLinesHtml, splitMarkupLines } from "./codeView.ts";

const textOf = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const balanced = (html: string) => (html.match(/<span[^>]*>/g) ?? []).length === (html.match(/<\/span>/g) ?? []).length;

describe("the file viewer's numbered text", () => {
  it("asks for the language by extension or a known name, and for nothing without one", () => {
    expect(codeLanguage("App.tsx")).toBe("tsx");
    expect(codeLanguage("bench.p95.PY")).toBe("py");
    expect(codeLanguage("Makefile")).toBe("makefile");
    expect(codeLanguage(".zshrc")).toBe("bash");
    expect(codeLanguage("README")).toBeNull();
    expect(codeLanguage(".gitignore")).toBeNull();
    expect(codeLanguage("trailing.")).toBeNull();
    // highlight.js takes each as an alias of a language it bundles
    for (const name of ["a.ts", "a.tsx", "a.js", "a.py", "a.rs", "a.go", "a.sh", "a.yml", "a.toml", "a.json", "a.md", "a.css", "a.html", "Makefile", ".bashrc"]) {
      expect(hljs.getLanguage(codeLanguage(name)!)).toBeDefined();
    }
  });

  it("colors what highlight.js knows, except Markdown under any of its names", () => {
    for (const language of ["ts", "tsx", "py", "json", "makefile", "bash"]) expect(highlightable(hljs, language)).toBe(true);
    for (const language of ["md", "markdown", "mkd", "mkdown", "log", "nope"]) expect(highlightable(hljs, language)).toBe(false);
    // the shape that makes highlight.js's Markdown grammar take seconds is never handed to it
    expect(highlightable(hljs, codeLanguage("plan.md")!)).toBe(false);
  });

  it("escapes text that was not marked up, and drops the \\r of a CRLF file", () => {
    expect(escapeHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
    expect(normalizeNewlines("one\r\ntwo\rthree\n")).toBe("one\ntwo\nthree\n");
  });

  it("cuts markup into lines that each close and reopen the spans running over them", () => {
    const html = `<span class="a">x</span>\n<span class="c">/* one\ntwo <span class="d">@k</span>\nthree */</span> y`;
    expect(splitMarkupLines(html)).toEqual([
      `<span class="a">x</span>`,
      `<span class="c">/* one</span>`,
      `<span class="c">two <span class="d">@k</span></span>`,
      `<span class="c">three */</span> y`,
    ]);
  });

  it("leaves out the empty line after a final newline, and keeps empty lines within", () => {
    expect(splitMarkupLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(splitMarkupLines(`<span class="s">a\n</span>`)).toEqual([`<span class="s">a</span>`]);
    expect(splitMarkupLines("")).toEqual([""]);
    expect(splitMarkupLines("\n")).toEqual([""]);
  });

  it("keeps highlight.js output whole: every line balanced, the text unchanged", () => {
    const source = "/**\n * Doc <b>&</b>\n */\nconst s = `a\n${b}\nc`;\n\nfunction f(x: number) { return x > 1 && x < 2; }\n";
    const lines = splitMarkupLines(hljs.highlight(source, { language: "ts", ignoreIllegals: true }).value);
    expect(lines.length).toBe(8);
    expect(lines.every(balanced)).toBe(true);
    expect(lines.map(textOf).join("\n") + "\n").toBe(source);
    expect(lines[1]).toStartWith(`<span class="hljs-comment">`);
  });

  it("gives each line a block that holds its own newline", () => {
    expect(numberedLinesHtml(["a", ""])).toBe(`<span class="file-viewer-line">a\n</span><span class="file-viewer-line">\n</span>`);
  });
});
