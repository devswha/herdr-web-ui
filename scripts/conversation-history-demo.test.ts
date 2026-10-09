import { expect, it } from "bun:test";
import { createDemoHistory } from "../site/demo/history.ts";
import type { ConversationHistoryResponse } from "../shared/conversation-history.ts";
import type { ConversationResponse, ConversationTurn } from "../shared/protocol.ts";

it("serves fictional pane-less pages, output and images without launching", async () => {
  let created = 0;
  const handle = createDemoHistory(() => { created++; return { pane_id: "new-pane", workspace_id: "new-workspace" }; }, () => false);
  const get = (path: string) => {
    const response = handle(new URL(`http://demo.example/api/conversations${path}`), "GET");
    if (!response) throw new Error("missing demo history response");
    return response;
  };
  const listed: ConversationHistoryResponse = await get("").json();
  expect(listed.conversations).toHaveLength(2);
  const omo = listed.conversations.find((entry) => entry.agent === "omo");
  const claude = listed.conversations.find((entry) => entry.agent === "claude");
  if (!omo || !claude) throw new Error("missing fictional records");
  const first: ConversationResponse = await get(`/${omo.id}`).json();
  const previous: ConversationResponse = await get(`/${omo.id}?before=${first.cursor}`).json();
  expect(first.turns[0]?.role).toBe("assistant");
  expect(previous.turns[0]?.role).toBe("user");
  expect(previous.cursor).toBeNull();
  expect(get(`/${omo.id}?before=foreign`).status).toBe(409);
  const tool = first.turns[0]?.parts.find((part) => part.kind === "tool");
  if (!tool || tool.kind !== "tool" || !tool.output_ref) throw new Error("missing saved tool");
  const complete: { output: string } = await get(`/${omo.id}/tool-output?ref=${tool.output_ref}`).json();
  expect(complete.output.length).toBeGreaterThan(tool.output.length);
  const picture: ConversationResponse = await get(`/${claude.id}`).json();
  const image = picture.turns[0]?.parts.find((part) => part.kind === "image");
  if (!image || image.kind !== "image") throw new Error("missing saved image");
  const bytes = get(`/${claude.id}/image?ref=${image.ref}`);
  expect(bytes.headers.get("content-type")).toBe("image/png");
  expect([...new Uint8Array(await bytes.arrayBuffer()).slice(0, 4)]).toEqual([137, 80, 78, 71]);
  expect(get(`/${omo.id}/image?ref=invalid`).status).toBe(404);
  expect(created).toBe(0);
});

it("reuses a fictional live OmO resume and keeps other closed agents read-only", async () => {
  const opens: ConversationTurn[][] = [];
  let live = false;
  const handle = createDemoHistory((_record, turns) => {
    opens.push(turns);
    live = true;
    return { pane_id: "new-pane", workspace_id: "new-workspace" };
  }, () => live);
  const resume = (id: string) => handle(new URL(`http://demo.example/api/conversations/${id}/resume`), "POST");
  const first = resume("a".repeat(64)), next = resume("a".repeat(64));
  expect(await first?.json()).toEqual(await next?.json());
  expect(opens).toHaveLength(1);
  expect(opens[0]?.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(resume("b".repeat(64))?.status).toBe(409);
  live = false;
  expect(resume("a".repeat(64))?.status).toBe(200);
  expect(opens).toHaveLength(2);
});
