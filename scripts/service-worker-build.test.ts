import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildId, stampServiceWorker } from "./service-worker-build.ts";

const source = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");

describe("service worker build stamp", () => {
  it("names a build after its hashed files only, in any order", () => {
    const files = ["assets/index-a1.js", "assets/katex-b2.js", "index.html", "sw.js"];
    expect(buildId(files)).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId([...files].reverse())).toBe(buildId(files));
    expect(buildId([...files, "THIRD_PARTY_NOTICES.md"])).toBe(buildId(files));
    expect(buildId(["assets/index-c3.js", "assets/katex-b2.js"])).not.toBe(buildId(files));
  });

  it("stamps the one BUILD line of public/sw.js and nothing else", () => {
    const stamped = stampServiceWorker(source, "0123456789ab");
    expect(stamped).toContain('const BUILD = "0123456789ab";');
    expect(stamped.replace('const BUILD = "0123456789ab";', 'const BUILD = "";')).toBe(source);
  });

  it("refuses a worker it cannot stamp, and a build id that is not one", () => {
    expect(() => stampServiceWorker(source.replace('const BUILD = "";', ""), "0123456789ab")).toThrow("exactly one");
    expect(() => stampServiceWorker(source, 'x"; evil()')).toThrow("not a build id");
  });
});
