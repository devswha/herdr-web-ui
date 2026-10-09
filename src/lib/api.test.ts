import { afterEach, expect, it } from "bun:test";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import type { OmoProgress } from "../../shared/protocol.ts";
import { AttachmentTooLargeError, fetchPaneOmoActivity, uploadPaneImage } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

it("keeps progress on the requested PC and accepts older bridges that omit it", async () => {
  const paths: string[] = [];
  const progress = { session_id: "owned", todos: [], activity: "idle" } satisfies OmoProgress;
  let body: object = { tasks: [], runs: [], progress, server_time: "2026-10-09T00:00:00Z" };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    paths.push(String(input));
    return Response.json(body);
  }, { preconnect: realFetch.preconnect });
  expect((await fetchPaneOmoActivity("p:1", "remote-a")).progress).toEqual(progress);
  body = { tasks: [] };
  expect(await fetchPaneOmoActivity("p:1", "local")).toEqual({ tasks: [], runs: [], progress: undefined, serverTime: null });
  expect(paths).toEqual(["/api/machines/remote-a/pane/omo-tasks?pane_id=p%3A1", "/api/pane/omo-tasks?pane_id=p%3A1"]);
});

it("refuses a file over the attachment limit before any of it is sent, and sends one at the limit", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return Response.json({ ok: true, path: "/work/.herdr-web-ui/site.zip" });
  }) as typeof fetch;

  const over = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "site.zip", { type: "application/zip" });
  const refused = await uploadPaneImage("p1", over).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(AttachmentTooLargeError);
  expect(refused).toMatchObject({ fileName: "site.zip", size: MAX_ATTACHMENT_BYTES + 1 });
  expect(requests).toEqual([]);

  const atLimit = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "site.zip", { type: "application/zip" });
  expect(await uploadPaneImage("p1", atLimit)).toBe("/work/.herdr-web-ui/site.zip");
  expect(requests).toEqual(["/api/pane/image"]);
});
