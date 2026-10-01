/**
 * xterm's DOM renderer sizes every cell from the Latin font and gives each glyph the
 * difference to its cells as letter-spacing, which lands after the glyph: a narrower glyph
 * sits at the left edge of its cells. With a 1em CJK fallback beside a 0.54em Latin cell
 * (Linux) that leftover is a pixel. Apple's Menlo cell is 0.6em, though, and no font on
 * iPhone draws Hangul wider than 0.87em, so every syllable trailed a 4px gap and Korean read
 * as falling apart (kana and Han too, at 0.87em to 1em).
 *
 * So each span the renderer draws with extra spacing is adjusted after the fact:
 * - a glyph in two cells that fills less than FILL of them is drawn larger, up to
 *   MAX_SCALE, the way a CJK coding font sizes it against its Latin;
 * - the glyph is centered in its cells: padding moves the text right by half the spacing
 *   left over, a negative margin takes it back after the span so the next span keeps its
 *   column, and a clip trims the trailing half so a background or block cursor stays on its
 *   own cells.
 * A glyph wider than its cells is left to run over, as in a native terminal.
 *
 * The renderer also hands the browser each cell's text as written, and two kinds of text
 * draw wrong on iPhone:
 * - iOS Safari draws only the first of two stacked marks on a decomposed letter (`e` +
 *   U+0302 + U+0301, as in a Vietnamese file name from a Mac), so such text is shown composed
 *   (NFC), and decomposed Hangul with it, which then measures as the syllable it is;
 * - iOS draws a symbol that is text by default, such as ⏺ (the bullet before every Claude
 *   Code message), as a color emoji two cells wide in its one cell, so a symbol that
 *   overflows its cell is asked for its text form (U+FE0E).
 * Copy reads xterm's buffer, not the DOM, and still returns what the pane wrote.
 */
import type { Terminal } from "@xterm/xterm";

/** Spacing up to this is rounding between the font and the cell grid, not a misfit glyph. */
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
/** A pictograph that is text by default. */
const TEXT_DEFAULT_PICTOGRAPH = /(?!\p{Emoji_Presentation})\p{Extended_Pictographic}/gu;
const PRESENTATION_SELECTOR = /[\ufe0e\ufe0f]/u;
const TEXT_PRESENTATION = "\ufe0e";

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
 * `text` with every text-default pictograph asking for its text form, or null when there is
 * none or the text already chooses a presentation somewhere. A span is fitted as a whole, so
 * its glyphs either all switch to text or all stay as xterm measured them.
 */
export function textPresentation(text: string): string | null {
  if (PRESENTATION_SELECTOR.test(text)) return null;
  const textForm = text.replace(TEXT_DEFAULT_PICTOGRAPH, `$&${TEXT_PRESENTATION}`);
  return textForm === text ? null : textForm;
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
  // glyph advances by "<bold><italic><text>", for the font they were measured in
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
      let shown = displayText(text);
      const xtermSpacing = Number.parseFloat(span.style.letterSpacing);
      if (!(Math.abs(xtermSpacing) > MIN_SPACING_PX)) {
        if (shown !== text) span.textContent = shown;
        continue;
      }
      const bold = span.classList.contains("xterm-bold");
      const italic = span.classList.contains("xterm-italic");
      const widthOf = (glyph: string): number => {
        const key = `${bold ? 1 : 0}${italic ? 1 : 0}${glyph}`;
        let width = widths.get(key);
        if (width === undefined) {
          measure.font = `${italic ? "italic " : ""}${bold ? fontWeightBold : fontWeight} ${font}`;
          width = measure.measureText(glyph).width;
          widths.set(key, width);
        }
        return width;
      };
      // a span merges only cells drawn with the same spacing, so its first glyph speaks for all
      const first = String.fromCodePoint(shown.codePointAt(0) ?? 0x20);
      let glyphWidth = widthOf(first);
      let spacing = xtermSpacing;
      // the spacing is re-measured from the first glyph, so that glyph must be one that switches
      const textForm = spacing < 0 ? textPresentation(shown) : null;
      if (textForm?.startsWith(first + TEXT_PRESENTATION)) {
        const slot = glyphWidth + spacing;
        shown = textForm;
        glyphWidth = widthOf(first + TEXT_PRESENTATION);
        spacing = slot - glyphWidth;
      }
      if (shown !== text) span.textContent = shown;
      const fit = glyphFit(spacing, glyphWidth, cellWidth);
      if (!fit) {
        if (spacing !== xtermSpacing) span.style.letterSpacing = `${spacing}px`;
        continue;
      }
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
