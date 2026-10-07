import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { DeviceStore } from "./devices.ts";

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
    server = createServer({ port: 0, stateDir: root });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop());

  it("is let in with nothing set up, and can start a pairing: the local-dev path", async () => {
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

  it("watches, and reaches nothing the terminals do not show it", async () => {
    expect((await fetch(`${base}/api/devices`, { headers: { cookie } })).status).toBe(200);
    // the filesystem is the one a watch role must never read: those files include credentials
    expect((await fetch(`${base}/api/fs/file?path=/etc/hostname`, { headers: { cookie } })).status).toBe(403);
  });
});
