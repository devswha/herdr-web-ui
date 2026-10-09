import type { ReactNode } from "react";

import { splitFilePaths } from "../lib/filePaths.ts";
import { useT } from "../lib/i18n.ts";

/**
 * Text past this many characters stays plain: a whole tool output can be megabytes, and every
 * path in it would be an element.
 */
export const FILE_LINK_LIMIT = 256 * 1024;

/** A file path the viewer opens: a button that reads as the text or code it replaced. */
export function FilePathLink({ path, code, open }: { path: string; code: boolean; open: (path: string) => void }) {
  const t = useT();
  const label = code ? <code>{path}</code> : path;
  return <button type="button" className={`markdown-file${code ? " is-code" : ""}`} title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button>;
}

/**
 * `text` with the file paths in it as links to the viewer (a tool's output, a log in a code
 * block): `/tmp/shot/t0.png (1600, 1000)` opens the picture. Plain where nothing can open one.
 */
export function linkFilePaths(text: string, open: ((path: string) => void) | null): ReactNode {
  if (open === null || text.length > FILE_LINK_LIMIT) return text;
  const parts = splitFilePaths(text);
  if (parts.length === 1 && typeof parts[0] === "string") return text;
  return parts.map((part, index) => typeof part === "string" ? part : <FilePathLink key={index} path={part.path} code={false} open={open} />);
}
