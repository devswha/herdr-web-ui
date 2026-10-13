import { describe, expect, it } from "bun:test";

import { lazyChunk, onLazyChunkFailure } from "./lazyChunk.ts";

describe("lazyChunk", () => {
  it("loads once while pending and once loaded", async () => {
    let calls = 0;
    const load = lazyChunk(async () => ++calls);
    const [a, b] = await Promise.all([load(), load()]);
    expect([a, b]).toEqual([1, 1]);
    expect(await load()).toBe(1);
    expect(calls).toBe(1);
  });

  it("asks again after a failure and tells every listener of it", async () => {
    let calls = 0;
    let told = 0;
    const stop = onLazyChunkFailure(() => { told++; });
    const failing = onLazyChunkFailure(() => { throw new Error("a broken listener"); });
    try {
      const load = lazyChunk(async () => {
        calls++;
        if (calls === 1) throw new TypeError("Failed to fetch dynamically imported module");
        return "katex";
      });
      await expect(load()).rejects.toThrow("Failed to fetch dynamically imported module");
      expect(told).toBe(1);
      // a tab that kept the failure would draw source text until a reload
      expect(await load()).toBe("katex");
      expect(calls).toBe(2);
      expect(told).toBe(1);
    } finally {
      stop();
      failing();
    }
  });

  it("stops telling a listener that was removed", async () => {
    let told = 0;
    onLazyChunkFailure(() => { told++; })();
    await expect(lazyChunk(() => Promise.reject(new Error("gone")))()).rejects.toThrow("gone");
    expect(told).toBe(0);
  });
});
