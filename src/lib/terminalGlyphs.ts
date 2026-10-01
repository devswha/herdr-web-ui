/**
 * xterm's DOM renderer sizes every cell from the Latin font and gives a glyph narrower than
 * its cells the rest as letter-spacing, which lands after the glyph: the glyph sits at the
 * left edge of its cells. With a 1em CJK fallback beside a 0.54em Latin cell (Linux) that
 * leftover is a pixel. Apple's Menlo cell is 0.6em, though, and no font on iPhone draws
 * Hangul wider than 0.87em, so every syllable trailed a 4px gap and Korean read as falling
 * apart (kana and Han too, at 0.87em to 1em).
 *
 * So each span the renderer draws with extra spacing is adjusted after the fact:
 * - a glyph in two cells that fills less than FILL of them is drawn larger, up to
 *   MAX_SCALE, the way a CJK coding font sizes it against its Latin;
 * - the glyph is centered in its cells: padding moves the text right by half the spacing
 *   left over, a negative margin takes it back after the span so the next span keeps its
 *   column, and a clip trims the trailing half so a background or block cursor stays on
 *   its own cells.
 *
 * The renderer also hands the browser each cell's text as written. iOS Safari draws only
 * the first of two stacked marks on a decomposed letter (`e` + U+0302 + U+0301, as in a
 * Vietnamese file name from a Mac), so such text is shown composed (NFC), and decomposed
 * Hangul with it, which then measures as the syllable it is. Copy reads xterm's buffer, not
 * the DOM, and still returns what the pane wrote.
 */
import type { Terminal } from "@xterm/xterm";

/** Spacing up to this is rounding between the font and the cell grid, not a narrow glyph. */
const MIN_SPACING_PX = 1;
/**
 * A glyph filling this much of its cells is left as drawn (a 1em CJK glyph on Linux fills
 * 93%); a narrower one is centered, and a two-cell one enlarged to fill this much.
 */
const FILL = 0.9;
/** The most a wide glyph is enlarged, so it never towers over the Latin beside it. */
const MAX_SCALE = 1.2;

/** Combining marks, and the Hangul vowel and final jamo a decomposed syllable continues with. */
const DECOMPOSED = /[\p{M}\u1160-\u11ff]/u;

export interface GlyphFit {
  /** font-size multiplier for the span; 1 keeps it */
  scale: number;
  /** the letter-spacing left after scaling; its half goes before each glyph */
  spacing: number;
}

/**
 * How to draw a span whose glyphs advance `glyphWidth` and get `spacing` added by xterm, in
 * a grid of `cellWidth` columns; null when the span is already right.
 */
export function glyphFit(spacing: number, glyphWidth: number, cellWidth: number): GlyphFit | null {
  if (!(spacing > MIN_SPACING_PX) || !(glyphWidth > 0) || !(cellWidth > 0)) return null;
  const slot = glyphWidth + spacing;
  if (glyphWidth >= FILL * slot) return null;
  const wide = Math.round(slot / cellWidth) >= 2;
  const scale = wide ? Math.min(MAX_SCALE, (FILL * slot) / glyphWidth) : 1;
  return { scale, spacing: slot - glyphWidth * scale };
}

/** The text to draw for a cell span: composed when it carries marks or decomposed Hangul. */
export function displayText(text: string): string {
  return DECOMPOSED.test(text) ? text.normalize("NFC") : text;
}

/**
 * Keeps every row the DOM renderer draws adjusted. The renderer rebuilds a row's spans on
 * each render (and on link hover, which fires no render event), so a MutationObserver
 * catches them all; it runs before the frame paints. Returns the stop function.
 */
export function adjustTerminalGlyphs(term: Terminal): () => void {
  const rows = term.element?.querySelector<HTMLElement>(".xterm-rows");
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const measure = document.createElement("canvas").getContext("2d");
  if (!rows || !screen || !measure) return () => {};
  // glyph advances by "<bold><italic><char>", for the font they were measured in
  const widths = new Map<string, number>();
  let measuredFont = "";

  const adjustAll = (spans: Iterable<Node>): void => {
    const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
    if (fontSize === undefined) return;
    const font = `${fontSize}px ${fontFamily}`;
    if (font !== measuredFont) {
      widths.clear();
      measuredFont = font;
    }
    const cellWidth = Number.parseFloat(screen.style.width) / term.cols;
    for (const span of spans) {
      if (!(span instanceof HTMLSpanElement)) continue;
      const text = span.textContent ?? "";
      const shown = displayText(text);
      if (shown !== text) span.textContent = shown;
      const spacing = Number.parseFloat(span.style.letterSpacing);
      if (!(spacing > MIN_SPACING_PX)) continue;
      // a span merges only cells drawn with the same spacing, so its first glyph speaks for all
      const first = String.fromCodePoint(shown.codePointAt(0) ?? 0x20);
      const bold = span.classList.contains("xterm-bold");
      const italic = span.classList.contains("xterm-italic");
      const key = `${bold ? 1 : 0}${italic ? 1 : 0}${first}`;
      let glyphWidth = widths.get(key);
      if (glyphWidth === undefined) {
        measure.font = `${italic ? "italic " : ""}${bold ? fontWeightBold : fontWeight} ${font}`;
        glyphWidth = measure.measureText(first).width;
        widths.set(key, glyphWidth);
      }
      const fit = glyphFit(spacing, glyphWidth, cellWidth);
      if (!fit) continue;
      const half = fit.spacing / 2;
      // appended in one write: later declarations win over xterm's letter-spacing
      span.style.cssText += `;${fit.scale !== 1 ? `font-size:${fontSize * fit.scale}px;` : ""}letter-spacing:${fit.spacing}px;padding-left:${half}px;margin-right:${-half}px;clip-path:inset(0 ${half}px 0 0)`;
    }
  };

  adjustAll(rows.querySelectorAll("span"));
  const observer = new MutationObserver((records) => {
    for (const record of records) adjustAll(record.addedNodes);
  });
  observer.observe(rows, { childList: true, subtree: true });
  return () => observer.disconnect();
}
