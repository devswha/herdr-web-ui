import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { FileInfo } from "../../shared/protocol.ts";
import { faviconKey, forgetFaviconProbes, probeFavicon } from "./projectFavicon.ts";

const realFetch = globalThis.fetch;
const icon = (path: string): FileInfo => ({ path, name: path.slice(path.lastIndexOf("/") + 1), size: 3, modified: "2026-01-01T00:00:00.000Z", mime: "image/svg+xml", kind: "image" });
const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

/** Answers each request with the next response (the last one repeats) and records what was asked. */
function serve(...responses: (Response | Error)[]): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return asked;
}

describe("project favicon probe", () => {
  beforeEach(forgetFaviconProbes);
  afterEach(() => { globalThis.fetch = realFetch; });

  it("asks the workstation once for a folder's best icon, however many places it may be kept", async () => {
    const asked = serve(Response.json({ icon: icon("/work/app/public/favicon.ico") }));
    expect(await probeFavicon("local", "/work/app")).toBe("/work/app/public/favicon.ico");
    expect(asked).toEqual([`/api/fs/favicon?root=${encodeURIComponent("/work/app")}`]);
  });

  it("takes a folder without an icon as an answer, and remembers it", async () => {
    const asked = serve(Response.json({ icon: null }));
    expect(await probeFavicon("local", "/x")).toBeNull();
    expect(await probeFavicon("local", "/x")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("probes a folder once, also for rows asking at the same time, and separately for another folder", async () => {
    const asked = serve(
      Response.json({ icon: icon("/x/favicon.svg") }),
      Response.json({ icon: icon("/y/logo.png") }),
    );
    const [first, second] = await Promise.all([probeFavicon("local", "/x"), probeFavicon("local", "/x")]);
    expect([first, second]).toEqual(["/x/favicon.svg", "/x/favicon.svg"]);
    expect(asked).toHaveLength(1);
    expect(await probeFavicon("local", "/y")).toBe("/y/logo.png");
    expect(asked).toEqual(["/api/fs/favicon?root=%2Fx", "/api/fs/favicon?root=%2Fy"]);
    expect(faviconKey("local", "/y")).not.toBe(faviconKey("local", "/x"));
  });

  it("asks again after a check that failed: a network error, an unavailable server, or a rate limit", async () => {
    for (const failure of [new TypeError("Failed to fetch"), error(502, "bad_gateway"), error(503, "server_unavailable"), error(429, "too_many_requests")]) {
      forgetFaviconProbes();
      const asked = serve(failure, Response.json({ icon: icon("/x/favicon.ico") }));
      expect(await probeFavicon("local", "/y")).toBeNull();
      expect(await probeFavicon("local", "/y")).toBe("/x/favicon.ico");
      expect(asked).toHaveLength(2);
    }
  });

  it("remembers a refusal: a watching device, or a server without the route", async () => {
    for (const refusal of [error(403, "read_only"), error(404, "not_found")]) {
      forgetFaviconProbes();
      const asked = serve(refusal);
      expect(await probeFavicon("local", "/y")).toBeNull();
      expect(await probeFavicon("local", "/y")).toBeNull();
      expect(asked).toHaveLength(1);
    }
  });
});
