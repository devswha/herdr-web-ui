/**
 * Reading the theme blocks of src/styles.css as data. Pure: no DOM and no file access, callers pass
 * the CSS text. Runtime code never imports this module.
 */

/**
 * The one spelling every theme value is compared in: whitespace collapsed, hex lowercased, and
 * `rgba(r,g,b,a)` written `rgba(r, g, b, a)` with the alpha's trailing zeros dropped. Nothing else
 * normalizes theme values for a comparison.
 */
export function normalizeThemeValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/#[0-9a-f]{3,8}\b/gi, (hex) => hex.toLowerCase())
    .replace(/rgba\(([^()]*)\)/gi, (_, args: string) => `rgba(${args.split(",").map((part) => String(Number(part.trim()))).join(", ")})`);
}
