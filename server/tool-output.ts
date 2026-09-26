import type { ConversationPart } from "../shared/protocol.ts";

/** Past this a tool's output is cut in the page; the rest is fetched on request (toolOutput). */
export const TOOL_OUTPUT_CHARS = 4000;

/** Sets a tool part's output, cut to what a page carries, keeping what it takes to fetch the rest. */
export function trimOutput(tool: Extract<ConversationPart, { kind: "tool" }>, output: string, ref: string): void {
  if (output.length <= TOOL_OUTPUT_CHARS) { tool.output = output; return; }
  tool.output = `${output.slice(0, TOOL_OUTPUT_CHARS)}\n… trimmed`;
  tool.output_ref = ref;
  tool.output_size = output.length;
}
