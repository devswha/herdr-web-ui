import { fileUriPath } from "./terminalFileLinks.ts";

/**
 * Where an image of a markdown file lives, as a path the file endpoint reads: a `file://` URI or
 * an absolute path as written, a relative one from the folder of the markdown file. Null for what
 * the page cannot load (an http address: the CSP allows own-origin images only) or cannot place
 * (`~`, a Windows drive).
 */
export function markdownImagePath(src: string, markdownPath: string): string | null {
  const target = src.trim().replace(/[?#].*$/s, "");
  if (target === "" || /^(?:https?:|data:|blob:|\/\/)/i.test(src.trim())) return null;
  let path: string;
  try { path = decodeURI(fileUriPath(target) ?? target); } catch { return null; }
  if (/^~|^[A-Za-z]:|\\/.test(path)) return null;
  if (!path.startsWith("/")) {
    const folder = markdownPath.slice(0, markdownPath.lastIndexOf("/") + 1);
    if (!folder.startsWith("/")) return null;
    path = folder + path;
  }
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
