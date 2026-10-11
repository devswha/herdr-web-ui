/** Bounds are application budgets, not a guarantee of interrupting Mermaid's main-thread work. */
export interface MermaidImage { svg: string; width: number; height: number }
export type MermaidTheme = "dark" | "light";
const MAX_SOURCE = 20_000;
const MAX_SVG = 1024 * 1024;

/** Refuse active/configuration/resource syntax before the library creates any temporary DOM. */
export function mermaidInputAllowed(source: string): boolean {
  if (!source.trim() || source.length > MAX_SOURCE) return false;
  if (/^\s*---(?:\s|$)/.test(source) || /%%\s*\{/.test(source)) return false;
  if (/<\s*\/?\s*[a-z!][^>]*>/i.test(source) || /&(?:amp;)*(?:lt|gt|#0*(?:60|62)|#x0*3[ce]);/i.test(source) || /!\s*\[|@\s*\{|\b(?:fa|fab|fas|icon):/i.test(source)) return false;
  if (/(?:^|[;\n\r\u2028\u2029])\s*(?:classDef|style|linkStyle|click|cssClass)\b/i.test(source)) return false;
  const first = source.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("%%")) ?? "";
  return /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|pie|journey|gantt|gitGraph|mindmap|timeline|quadrantChart|sankey-beta|block-beta|packet-beta)\b/.test(first);
}

/** Own the entire initialize/render/cleanup operation; the library's queue only owns render. */
export function createMermaidQueue(renderer: (source: string, theme: MermaidTheme) => Promise<MermaidImage>, limits: { entries?: number; bytes?: number; pending?: number } = {}) {
  const cache = new Map<string, MermaidImage>();
  const pending = new Map<string, Promise<MermaidImage>>();
  const encoder = new TextEncoder();
  const size = (value: MermaidImage) => encoder.encode(value.svg).byteLength;
  const entries = limits.entries ?? 32;
  const bytes = limits.bytes ?? 4 * 1024 * 1024;
  let retained = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return { render(source: string, theme: MermaidTheme): Promise<MermaidImage> {
    if (!mermaidInputAllowed(source)) return Promise.reject(new Error("unsupported diagram input"));
    const key = `${theme}\0${source}`;
    const remembered = cache.get(key);
    if (remembered) { cache.delete(key); cache.set(key, remembered); return Promise.resolve(remembered); }
    const running = pending.get(key);
    if (running) return running;
    if (pending.size >= (limits.pending ?? 8)) return Promise.reject(new Error("diagram queue busy"));
    const result = tail.then(() => renderer(source, theme)).then((value) => {
      const length = size(value);
      if (length <= bytes && entries > 0) {
        while (cache.size && (cache.size >= entries || retained + length > bytes)) {
          const oldest = cache.keys().next().value!;
          retained -= size(cache.get(oldest)!); cache.delete(oldest);
        }
        cache.set(key, value); retained += length;
      }
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, result);
    tail = result.catch(() => {});
    return result;
  } };
}

/** XML validation complements the pre-render gate; final output is displayed only as an image. */
export function validateMermaidSvg(svg: string): MermaidImage {
  if (new TextEncoder().encode(svg).byteLength > MAX_SVG || /<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) throw new Error("unsupported diagram output");
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = xml.documentElement;
  if (xml.querySelector("parsererror") || root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("invalid diagram output");
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! <= 0 || box[3]! <= 0 || box[2]! > 10_000 || box[3]! > 10_000 || box[2]! * box[3]! > 16_000_000) throw new Error("invalid diagram size");
  const resourceCss = (value: string) => /@(?!(?:keyframes|media)\b)|\\|\/\*|expression\s*\(|-moz-binding|behavior\s*:/i.test(value) || [...value.matchAll(/url\s*\(\s*([^)]*)\)/gi)].some((match) => !/^['"]?#[\w:.-]+['"]?$/.test(match[1]!.trim()));
  const allowed = new Set(["svg", "g", "path", "text", "tspan", "defs", "marker", "polygon", "polyline", "line", "rect", "circle", "ellipse", "title", "desc", "style", "clipPath", "linearGradient", "radialGradient", "stop", "symbol", "use", "filter", "feGaussianBlur", "feOffset", "feColorMatrix", "feBlend", "feComposite", "feFlood", "feMerge", "feMergeNode", "feDropShadow"]);
  for (const node of [root, ...root.querySelectorAll("*")]) {
    if (node.namespaceURI !== root.namespaceURI || !allowed.has(node.localName)) throw new Error(`unsupported diagram element (${node.localName})`);
    if (node.localName === "style" && resourceCss(node.textContent ?? "")) throw new Error(`unsupported diagram style (${/@[\w-]+/.exec(node.textContent ?? "")?.[0] ?? "resource"})`);
    for (const attr of node.attributes) {
      if (/^on/i.test(attr.name) || (attr.localName === "href" && !/^#[\w:.-]+$/.test(attr.value)) || resourceCss(attr.value)) throw new Error("unsupported diagram attribute");
    }
  }
  return { svg, width: box[2]!, height: box[3]! };
}

let library: Promise<typeof import("mermaid").default> | undefined;
let serial = 0;
const queue = createMermaidQueue(async (source, theme) => {
  library ??= import("./mermaid.ts").then((module) => module.default);
  const mermaid = await library;
  const container = document.createElement("div");
  container.className = "mermaid-render-host";
  container.setAttribute("aria-hidden", "true");
  container.inert = true;
  document.body.append(container);
  try {
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      htmlLabels: false, flowchart: { htmlLabels: false }, arrowMarkerAbsolute: false,
      maxTextSize: MAX_SOURCE, maxEdges: 200, theme: theme === "dark" ? "dark" : "default",
      fontFamily: "system-ui, sans-serif", altFontFamily: "system-ui, sans-serif", themeCSS: "",
      secure: ["secure", "securityLevel", "startOnLoad", "suppressErrorRendering", "maxTextSize", "maxEdges", "htmlLabels", "flowchart", "theme", "themeCSS", "themeVariables", "fontFamily", "altFontFamily", "layout", "arrowMarkerAbsolute"],
    });
    const { svg } = await mermaid.render(`herdr-mermaid-${serial++}`, source, container);
    return validateMermaidSvg(svg);
  } finally { container.remove(); }
});

export const renderMermaid = queue.render;
