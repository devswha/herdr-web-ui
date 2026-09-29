import { trimUrl } from "./markdown.ts";

/**
 * ssh's stderr as the setup dialog shows it. Tailscale SSH's browser check prints a URL and
 * waits until it is visited, so an address has to be clickable. Only https addresses link:
 * the text comes from a remote host, and nothing else it prints should become a control.
 */
export type SshOutputPart = { type: "text"; value: string } | { type: "link"; href: string; value: string };

export function sshOutputParts(text: string): SshOutputPart[] {
  const parts: SshOutputPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    const index = match.index ?? 0;
    const url = trimUrl(match[0]);
    // a bare scheme ("https://") is not an address
    if (url.length <= "https://".length) continue;
    if (index > offset) parts.push({ type: "text", value: text.slice(offset, index) });
    parts.push({ type: "link", href: url, value: url });
    offset = index + url.length;
  }
  if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
  return parts;
}
