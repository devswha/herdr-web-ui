import { stripVTControlCharacters } from "node:util";

export interface CodexSteeringContext { agent: string | null; working: boolean; screen: string }
interface SteeringIO {
  read: () => Promise<CodexSteeringContext>;
  escape: () => Promise<void>;
  restarting: () => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const STEERING_HINT = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const compact = (text: string) => text.replace(/\s/g, "");
function lastLine(lines: string[], matches: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index--) if (matches(lines[index]!)) return index;
  return -1;
}
/** The rows under the composer: the model and folder, context left, warnings, and (0.162) the shortcuts hint. */
const FOOTER = /^(?:\S+\s+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)\s*·|\d+% context left\b|⚠\s*\d+\s*warnings?\b|(?:←[^·]*·\s*)?\?\s*for shortcuts\b|[/\\]|[A-Za-z]:\\)/;

/**
 * A native steering panel in the live composer, never a hint quoted in scrollback, whose last
 * entry is `text`: the message just submitted, not one that was already waiting. Codex wraps an
 * entry over indented rows and cuts a long one with a "…" row, so the entry is compared without
 * whitespace, and as the start of `text` when it was cut.
 */
export function codexSteeringPending(screen: string, text: string): boolean {
  const lines = stripVTControlCharacters(screen).split(/\r?\n/).map((line) => line.trim().replace(/^│\s*|\s*│$/g, "")).filter(Boolean);
  const composer = lastLine(lines, (line) => /^›(?:\s+Ask Codex to do anything)?$/.test(line));
  if (composer < 0) return false;
  const footer = lines.slice(composer + 1);
  if (footer.length > 4 || footer.some((line) => !FOOTER.test(line))) return false;
  const status = lastLine(lines.slice(0, composer), (line) => /^[•◦]\s*(?:Working|Reconnecting(?:\.{3}|…)?(?: waiting for network)?)\s*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)$/.test(line));
  if (status < 0) return false;
  const panel = lines.slice(status + 1, composer);
  const message = panel.findIndex((line) => /^↳\s*\S/.test(line));
  if (message < 1) return false;
  if (compact(panel.slice(0, message).join("").replace(/^[•◦]\s*/, "")) !== compact(STEERING_HINT)) return false;
  const last = compact(panel.slice(lastLine(panel, (line) => /^↳\s*\S/.test(line))).join("").replace(/^↳/, ""));
  const sent = compact(text);
  if (!sent) return false;
  return last.endsWith("…") ? last.length > 1 && sent.startsWith(last.slice(0, -1)) : last === sent;
}

/** Enter can leave steering pending until a tool boundary. Only Send now may interrupt it, and only for `text`. */
export async function interruptCodexSteering(explicit: boolean, text: string, submitted: CodexSteeringContext, io: SteeringIO): Promise<void> {
  if (!explicit || submitted.agent !== "codex" || !submitted.working) return;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  const deadline = now() + 1500;
  const unconfirmed = () => new Error("Codex immediate delivery was not confirmed. Check the terminal before sending again.");
  while (now() < deadline) {
    // The caller rechecks live identity, lease, authority and interactive prompts in this read.
    const current = await io.read();
    if (now() >= deadline || current.agent !== "codex") throw unconfirmed();
    if (!current.working) return;
    if (codexSteeringPending(current.screen, text)) {
      io.restarting();
      await io.escape();
      return;
    }
    await wait(Math.min(50, deadline - now()));
  }
  throw unconfirmed();
}
