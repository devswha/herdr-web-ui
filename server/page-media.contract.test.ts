import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

it("a rendered page plays its large video by the address it was given, and nothing else without the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-page-media-"));
  const server = createServer({ port: 0, stateDir: join(root, "state"), token: "test-page-media", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const bytes = 9 * 1024 * 1024;
  try {
    writeFileSync(join(root, "clip.mp4"), "");
    truncateSync(join(root, "clip.mp4"), bytes);
    writeFileSync(join(root, "report.html"), `<video src="clip.mp4" controls></video>`);
    const page = await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "report.html"))}&render=1`, { headers: { authorization: "Bearer test-page-media" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(`media-src data: blob: ${base}/api/fs/page-media/`);
    const address = /src="(\/api\/fs\/page-media\/[A-Za-z0-9_-]{32})"/.exec(await page.text())?.[1];
    expect(address).toBeDefined();
    // as the sandboxed page asks for it: another site (it has no origin), no cookie, no token
    const fromPage = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "video" };
    const played = await fetch(`${base}${address}`, { headers: { ...fromPage, range: "bytes=0-9" } });
    expect(played.status).toBe(206);
    expect(played.headers.get("content-range")).toBe(`bytes 0-9/${bytes}`);
    expect(played.headers.get("content-type")).toBe("video/mp4");
    expect((await fetch(`${base}${address}`, { method: "HEAD", headers: fromPage })).status).toBe(200);
    // a guessed address, and the same file by its path, stay closed
    expect((await fetch(`${base}/api/fs/page-media/${"A".repeat(32)}`, { headers: fromPage })).status).toBe(404);
    expect((await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "clip.mp4"))}`, { headers: fromPage })).status).toBe(401);
    // and the address reads, never writes: another site's POST stops at the origin check before it
    expect((await fetch(`${base}${address}`, { method: "POST", headers: fromPage })).status).toBe(403);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
