import { afterEach, expect, it } from "bun:test";
import { fetchHerdrKeymap } from "./api.ts";
import { mergeHerdrKeymap } from "../../shared/herdr-keymap.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("retains each selected PC across overlapping reads", async () => {
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = Object.assign((input: string | URL | Request) => new Promise<Response>((resolve) => {
    pending.set(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, resolve);
  }), { preconnect: originalFetch.preconnect });
  const remote = fetchHerdrKeymap("work pc");
  const local = fetchHerdrKeymap("local");
  expect([...pending.keys()]).toEqual(["/api/machines/work%20pc/keybindings", "/api/keybindings"]);
  pending.get("/api/keybindings")?.(Response.json(mergeHerdrKeymap({ keys: { prefix: "ctrl+b" } })));
  pending.get("/api/machines/work%20pc/keybindings")?.(Response.json(mergeHerdrKeymap({ keys: { prefix: "ctrl+shift+8" } })));
  expect((await remote).prefix).toEqual(["ctrl+shift+8"]);
  expect((await local).prefix).toEqual(["ctrl+b"]);
});

it("reports an old remote bridge's missing endpoint rather than using local defaults", async () => {
  globalThis.fetch = Object.assign(async () => Response.json({ error: { code: "not_found", message: "old bridge" } }, { status: 404 }),
    { preconnect: originalFetch.preconnect });
  await expect(fetchHerdrKeymap("old-pc")).rejects.toMatchObject({ status: 404, code: "not_found" });
});
