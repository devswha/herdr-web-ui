import { expect, it } from "bun:test";
import { createServer } from "vite";
import config from "../vite.config.ts";
import { sameOrigin } from "../server/machine-security.ts";
import { updateRequestAllowed } from "../server/update-api.ts";

it("preserves browser origin through the development API proxy without accepting other origins", async () => {
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const allowed = sameOrigin(request) && (new URL(request.url).pathname.startsWith("/api/updates")
        ? updateRequestAllowed(request) : request.headers.get("x-herdr-machine") === "1");
      return Response.json({ allowed }, { status: allowed ? 200 : 403 });
    },
  });
  const proxy = config.server!.proxy!["/api"]!;
  const vite = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, proxy: {
      "/api": typeof proxy === "string" ? backend.url.origin : { ...proxy, target: backend.url.origin },
    } },
  });
  try {
    await vite.listen();
    const address = vite.httpServer!.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    for (const path of ["/api/machines/setup", "/api/machines/setup/test-job", "/api/updates/install"]) {
      for (const [source, site, status] of [
        [origin, "same-origin", 200],
        ["http://other.invalid", "cross-site", 403],
        ["http://other.invalid", "same-origin", 403],
      ] as const) {
        const response = await fetch(origin + path, { method: "POST", headers: {
          origin: source, "sec-fetch-site": site, "x-herdr-machine": "1", "x-herdr-update": "1",
          "content-type": "application/json",
        }, body: JSON.stringify({ action: "approve" }) });
        expect(response.status).toBe(status);
        await response.text();
      }
    }
  } finally { await vite.close(); backend.stop(true); }
});
