import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";
import { forgetAuthAttempts } from "./auth.ts";

/**
 * The access gate at the HTTP seam: what this PC needs to reach, and what a watching
 * device does not. `decideAccess` itself (loopback, Tailscale, token, device, open mode)
 * is covered in server/access.test.ts, and pairing initiation in server/devices.test.ts.
 */

const root = mkdtempSync(join(tmpdir(), "herdr-open-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("this PC, with no token and no configuration", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeAll(() => {
    forgetAuthAttempts();
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  it("is let in with nothing set up: the local-dev path", async () => {
    expect((await fetch(`${base}/api/devices`)).status).toBe(200);
    const started = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(started.status).toBe(200);
    expect((await started.json() as { code: string }).code).toMatch(/^\d{6}$/);
    // the gate is still open to strangers here: nothing is paired and no token exists,
    // which is why the address is refused outside this PC (server/access.ts)
    expect(new DeviceStore(root).gated).toBe(false);
  });
});

describe("a paired watch device", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  let cookie: string;
  beforeAll(() => {
    // paired before the server starts, so its own store holds the device
    const devices = new DeviceStore(root);
    const paired = devices.pair(devices.startPairing().code, "Watch", "watch")!;
    cookie = `herdr_web_device=${encodeURIComponent(paired.token)}`;
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  const asWatcher = (path: string, method = "GET") => fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, "x-herdr-machine": "1", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
  });

  it("keeps the filesystem, the directory listing and push/test out of reach", async () => {
    // its own credentials are a preference of that device, so signing out keeps working
    expect((await asWatcher("/api/auth", "DELETE")).status).toBe(204);
    // the filesystem and the directory listing are shape the terminal never shows it
    expect((await asWatcher("/api/fs/file?path=/etc/hostname")).status).toBe(403);
    expect((await asWatcher("/api/workspace/directories?cwd=/tmp")).status).toBe(403);
    expect((await asWatcher("/api/machines/local/workspace/directories?cwd=/tmp")).status).toBe(403);
    // sending an alert is not a preference: it makes the server POST somewhere
    expect((await asWatcher("/api/push/test", "POST")).status).toBe(403);
    // watching is the role's whole point
    expect((await asWatcher("/api/devices")).status).toBe(200);
  });

  it("is refused a pane read outside the enums, and the route's own method check", async () => {
    const read = await asWatcher("/api/pane/read?pane_id=w9999:p9999&source=bogus");
    expect(read.status).toBe(400);
    expect((await read.json() as { error: { code: string } }).error.code).toBe("invalid_source");
    const format = await asWatcher("/api/pane/read?pane_id=w9999:p9999&format=markdown");
    expect((await format.json() as { error: { code: string } }).error.code).toBe("invalid_format");
    // the same check on this PC, where the method is the only thing wrong
    const posted = await fetch(`${base}/api/pane/read?pane_id=w9999:p9999&source=visible`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect((await posted.json() as { error: { code: string } }).error.code).toBe("method_not_allowed");
  });
});