/** Fictional native histories; no filesystem, agent store or server import. */
import type { ConversationResponse, ConversationTurn } from "../../shared/protocol.ts";
import type { ResumeConversationResponse, SavedConversation } from "../../shared/conversation-history.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1sAAAAASUVORK5CYII=";
const output = "Guide links checked: 24 passed, 0 failed.";
const turns: ConversationTurn[] = [
  { role: "user", ts: "2026-10-01T09:00:00Z", parts: [{ kind: "text", text: "Check the guide links before publishing." }] },
  { role: "assistant", ts: "2026-10-01T09:01:00Z", parts: [
    { kind: "tool", name: "bash", summary: "Check guide links", input: "bun run check-links", output: "Guide links checked…", output_ref: "demo-output" },
    { kind: "text", text: "All links passed. The guide is ready for review." },
  ] },
];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

export function createDemoHistory(
  open: (record: SavedConversation, turns: ConversationTurn[]) => ResumeConversationResponse,
  alive: (paneId: string) => boolean,
) {
  const records: SavedConversation[] = [
    { id: "a".repeat(64), agent: "omo", title: "Guide release review", cwd: "/home/demo/docs-site",
      updated_at: Date.parse("2026-10-01T09:01:00Z"), session_id: "demo-guide-review", pane_id: null, state: "closed", can_resume: true, error: null },
    { id: "b".repeat(64), agent: "claude", title: "Saved diagram review", cwd: "/home/demo/checkout-api",
      updated_at: Date.parse("2026-09-30T09:01:00Z"), session_id: "demo-diagram-review", pane_id: null, state: "closed", can_resume: false, error: null },
  ];
  const bindings = new Map<string, ResumeConversationResponse>();
  return (url: URL, method: string): Response | null => {
    const path = url.pathname.replace(/^\/api\/machines\/local\//, "/api/");
    if (path !== "/api/conversations" && !path.startsWith("/api/conversations/")) return null;
    if (path === "/api/conversations" && method === "GET") return json({ conversations: records.map((record) => {
      const binding = bindings.get(record.id);
      const pane = binding && alive(binding.pane_id) ? binding.pane_id : null;
      return { ...record, pane_id: pane, state: pane ? "open" : "closed" };
    }) });
    const match = /^\/api\/conversations\/([a-f0-9]{64})(?:\/(resume|image|tool-output))?$/.exec(path);
    const record = records.find((candidate) => candidate.id === match?.[1]);
    if (!record) return fail("conversation_not_found", "No such saved conversation", 404);
    const action = match?.[2];
    if (action === "resume" && method === "POST") {
      const existing = bindings.get(record.id);
      if (existing && alive(existing.pane_id)) return json(existing);
      if (record.agent !== "omo") return fail("resume_unsupported", "Only OmO can launch closed history", 409);
      const binding = open(record, structuredClone(turns));
      bindings.set(record.id, binding);
      return json(binding);
    }
    if (method !== "GET" || action === "resume") return fail("method_not_allowed", "Use GET to read or POST to resume", 400);
    if (action === "tool-output") return url.searchParams.get("ref") === "demo-output"
      ? json({ output }) : fail("output_not_found", "No such saved output", 404);
    if (action === "image") {
      if (record.agent !== "claude" || url.searchParams.get("ref") !== "demo-image") return fail("image_not_found", "No such saved image", 404);
      return new Response(Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0)), {
        headers: { "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
      });
    }
    const before = url.searchParams.get("before");
    if (before !== null && before !== record.id) return fail("history_changed", "Saved history changed", 409);
    const page: ConversationResponse = {
      source: record.agent === "omo" ? "omo-transcript" : "claude-transcript", history_id: record.id,
      cursor: before === null ? record.id : null,
      turns: record.agent === "claude" && before === null
        ? [{ role: "user", ts: null, parts: [{ kind: "image", media_type: "image/png", ref: "demo-image" }] }]
        : structuredClone(before === null ? turns.slice(1) : turns.slice(0, 1)),
    };
    return json(page);
  };
}
