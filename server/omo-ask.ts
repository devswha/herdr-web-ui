/**
 * The questions an OmO session has open, as its session file records them: ask_user_question
 * (request_user_input under a Codex model), read the way OmO itself finds the questions it
 * restores after a restart (its ask-user extension, resume.js in omo 5.1.19).
 *
 * A call that waits for its answer (`waitForAnswer: true`) is open until its tool result, and only
 * while its message is the newest assistant message. A call that does not wait gets a result at
 * once that accepts it (`details: { accepted: true, status: "pending" }`); OmO folds it into a
 * widget over its input box and goes on, and it stays open until it is settled: an
 * `ask-user:settlement` record, or the answer delivered as a user message (`[Answer to question
 * <id>]`). A result that is an error (a malformed call) closes either kind.
 */

export const OMO_ASK_TOOLS: ReadonlySet<string> = new Set(["ask_user_question", "request_user_input"]);

export interface OmoAskCall {
  id: string;
  /** the call waits for its answer */
  wait: boolean;
  /** the call's arguments, as recorded */
  args: unknown;
}

/** The open calls, oldest first. */
export type OmoAsks = readonly OmoAskCall[];

interface Entry {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown; details?: unknown };
}

const ANSWER_FRAME_RE = /^\[Answer to question ([^\]\r\n]+)\]\r?\n/;

function waits(args: unknown): boolean {
  const record = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};
  return (record["waitForAnswer"] ?? record["wait_for_answer"]) !== false;
}

function without(open: OmoAsks, id: string): OmoAsks {
  return open.some((call) => call.id === id) ? open.filter((call) => call.id !== id) : open;
}

/** One session record, parsed, applied to the open calls. */
export function omoAsksAfter(open: OmoAsks, entry: Entry): OmoAsks {
  if (entry.type === "custom") {
    const id = entry.customType === "ask-user:settlement" ? (entry.data as { requestId?: unknown } | null)?.requestId : undefined;
    return typeof id === "string" ? without(open, id) : open;
  }
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role === "assistant") {
    const calls = (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])
      .filter((part) => part?.["type"] === "toolCall" && typeof part["id"] === "string" && OMO_ASK_TOOLS.has(part["name"] as string) && part["incomplete"] !== true)
      .map((part) => ({ id: part["id"] as string, wait: waits(part["arguments"]), args: part["arguments"] }));
    // a newer assistant message: a call that waited has had its answer
    return open.some((call) => call.wait) || calls.length > 0 ? [...open.filter((call) => !call.wait), ...calls] : open;
  }
  if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
    const details = (message.details ?? {}) as { accepted?: unknown; status?: unknown };
    const accepted = message.isError !== true && details.accepted === true && details.status === "pending";
    return accepted ? open : without(open, message.toolCallId);
  }
  if (message?.role === "user") {
    const texts = typeof message.content === "string" ? [message.content]
      : Array.isArray(message.content) ? (message.content as { type?: unknown; text?: unknown }[]).flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []) : [];
    return texts.reduce((rest, text) => {
      const id = ANSWER_FRAME_RE.exec(text)?.[1];
      return id === undefined ? rest : without(rest, id);
    }, open);
  }
  return open;
}

/**
 * A record too long to hold, by its ends (its role in the first bytes, a message's last content in
 * the last): the same rules, as far as the ends tell them. A question's own records are short.
 */
export function omoAsksAfterEnds(open: OmoAsks, head: string, tail: string): OmoAsks {
  if (!head.startsWith('{"type":"message"')) return open;
  const role = head.match(/"role":"(\w+)"/)?.[1];
  if (role === "assistant") {
    const calls: OmoAskCall[] = [];
    const found = [...tail.matchAll(/"type":"toolCall","id":"([^"]+)","name":"([^"]+)"/g)];
    found.forEach((match, index) => {
      if (!OMO_ASK_TOOLS.has(match[2]!)) return;
      const rest = tail.slice(match.index, found[index + 1]?.index ?? tail.length);
      calls.push({ id: match[1]!, wait: !/"(?:waitForAnswer|wait_for_answer)":false/.test(rest), args: null });
    });
    return open.some((call) => call.wait) || calls.length > 0 ? [...open.filter((call) => !call.wait), ...calls] : open;
  }
  if (role === "toolResult") {
    const id = head.match(/"toolCallId":"([^"]+)"/)?.[1];
    if (id === undefined) return open;
    const accepted = !tail.includes('"isError":true') && tail.includes('"accepted":true') && tail.includes('"status":"pending"');
    return accepted ? open : without(open, id);
  }
  if (role === "user") {
    const id = head.match(/"text":"\[Answer to question ([^\]"\\]+)\]\\n/)?.[1];
    return id === undefined ? open : without(open, id);
  }
  return open;
}
