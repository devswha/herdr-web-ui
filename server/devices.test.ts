import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Access } from "./access.ts";
import { DeviceStore, handleDeviceRequest, normalizeLabel } from "./devices.ts";
import { isTaggedNode, parseTailscaleOwner } from "./tailscale.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DeviceStore", () => {
  it("keeps an unreadable or invalid registry gated and intact for recovery", () => {
    for (const contents of ["{broken", "null", "{}", '{"devices":[]}', '{"gate_closed_at":null,"devices":[{}]}']) {
      const root = mkdtempSync(join(dir, "invalid-"));
      const path = join(root, "devices.json");
      writeFileSync(path, contents);
      const store = new DeviceStore(root);
      expect(store.gated).toBe(true);
      expect(store.error).toContain("Restore a valid devices.json");
      expect(() => store.startPairing()).toThrow();
      expect(() => store.revoke("any")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const unreadable = mkdtempSync(join(dir, "unreadable-"));
    mkdirSync(join(unreadable, "devices.json"));
    expect(new DeviceStore(unreadable).gated).toBe(true);
    const fresh = new DeviceStore(mkdtempSync(join(dir, "fresh-")));
    expect(fresh.error).toBeNull();
    expect(fresh.gated).toBe(false);
  });

  it("closes only the revoked device's listeners, including late registrations", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "listeners-")));
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    const unsubscribe = store.onRevoke(a.device.id, () => closed.push("finished"));
    unsubscribe();
    store.revoke(a.device.id);
    store.onRevoke(a.device.id, () => closed.push("late upgrade"));
    expect(closed).toEqual(["a", "late upgrade"]);
    expect(store.match(b.token)).not.toBeNull();
  });

  it("pairs with the code once, keeps only a hash, and finds the device by its token", () => {
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(false);
    const { code } = store.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pair("000000".replace(/./g, (c) => c === code[0] ? "1" : c), "x", "drive")).toBeNull(); // a wrong code
    const paired = store.pair(code.slice(0, 3) + " " + code.slice(3), "My phone", "drive");
    expect(paired).not.toBeNull();
    expect(store.pair(code, "again", "drive")).toBeNull(); // spent
    expect(store.gated).toBe(true);
    const file = readFileSync(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(paired!.token);
    expect((statSync(join(dir, "devices.json")).mode & 0o777)).toBe(0o600);
    expect(store.match(paired!.token)).toEqual({ id: paired!.device.id, label: "My phone", role: "drive" });
    expect(store.match("not-a-token")).toBeNull();
    // and a second store reading the same file knows the device
    expect(new DeviceStore(dir).match(paired!.token)?.label).toBe("My phone");
  });

  it("expires a code after ten minutes and after five wrong tries", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "s-")));
    const started = Date.now();
    const { code } = store.startPairing(started);
    expect(store.pair(code, "late", "drive", started + 10 * 60_000 + 1)).toBeNull();
    const second = store.startPairing().code;
    for (let i = 0; i < 5; i++) expect(store.pair("999999" === second ? "000000" : "999999", "x", "drive")).toBeNull();
    expect(store.pair(second, "x", "drive")).toBeNull();
  });

  it("renames, revokes, and marks the caller's device", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "r-")));
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    expect(store.list(a.device.id).map((d) => [d.label, d.current])).toEqual([["A", true], ["B", false]]);
    expect(store.update(b.device.id, { label: "Bee" })?.label).toBe("Bee");
    expect(store.revoke(a.device.id)).toBe(true);
    expect(store.revoke(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)?.label).toBe("Bee");
    // revoking the last device does not reopen the gate, not even after a restart
    expect(store.revoke(b.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(join(dir, "r-") === "" ? dir : (store as unknown as { path: string }).path.replace(/\/devices\.json$/, "")).gated).toBe(true);
  });
});

describe("labels and owner", () => {
  it("trims labels and falls back", () => {
    expect(normalizeLabel("  my   phone ", "Device")).toBe("my phone");
    expect(normalizeLabel("", "Device")).toBe("Device");
    expect(normalizeLabel(42, "Device")).toBe("Device");
    expect(normalizeLabel("x".repeat(80), "Device")).toHaveLength(48);
  });

  it("reads the PC's login out of tailscale status", () => {
    const status = JSON.stringify({ Self: { UserID: 42 }, User: { "42": { LoginName: "me@example.com" }, "43": { LoginName: "them@example.com" } } });
    expect(parseTailscaleOwner(status)).toBe("me@example.com");
    expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull();
    // a real id is past 2^53: as a double it becomes ...136 and names nobody (#526)
    expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe("me@example.com");
    expect(parseTailscaleOwner(null)).toBeNull();
    expect(parseTailscaleOwner("nope")).toBeNull();
    expect(isTaggedNode(status)).toBeFalse();
    // a tagged node's user entry is the node itself: no person's login
    const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ["tag:server"] }, User: { "7": { LoginName: "pc.tailnet.ts.net" } } });
    expect(parseTailscaleOwner(tagged)).toBeNull();
    expect(isTaggedNode(tagged)).toBeTrue();
    expect(isTaggedNode(null)).toBeFalse();
  });
});

it("reports failed registry writes without committing a pair, rename or revocation in memory", () => {
  const root = mkdtempSync(join(dir, "write-failure-"));
  const store = new DeviceStore(root);
  const first = store.pair(store.startPairing().code, "Original", "drive")!;
  let closed = false;
  store.onRevoke(first.device.id, () => { closed = true; });
  const blocked = join(root, `devices.json.${process.pid}.tmp`);
  mkdirSync(blocked);
  const code = store.startPairing().code;
  expect(() => store.pair(code, "Failed pair", "drive")).toThrow();
  expect(() => store.update(first.device.id, { label: "Failed rename" })).toThrow();
  expect(() => store.revoke(first.device.id)).toThrow();
  expect(closed).toBe(false);
  expect(store.list(null).map((d) => d.label)).toEqual(["Original"]);
  expect(store.match(first.token)?.label).toBe("Original");
  expect(new DeviceStore(root).match(first.token)?.label).toBe("Original");
  rmSync(blocked, { recursive: true });
  expect(store.pair(code, "Retry", "drive")).not.toBeNull();
  expect(store.revoke(first.device.id)).toBe(true);
  expect(closed).toBe(true);
  expect(new DeviceStore(root).match(first.token)).toBeNull();
});

describe("starting a pairing", () => {
  const start = (access: Access): Promise<Response> => handleDeviceRequest(
    new Request("http://127.0.0.1:7317/api/devices/pair/start", { method: "POST", headers: { origin: "http://127.0.0.1:7317", "x-herdr-machine": "1" } }),
    "/api/devices/pair/start",
    store,
    access,
  );
  const owner = (via: "local" | "tailscale" | "token"): Access => ({ level: "full", via, role: "drive" });
  const store = new DeviceStore(mkdtempSync(join(dir, "owner-")));

  it("is the owner's act, and never a stranger's", async () => {
    // this PC, the shared token and the PC's own Tailscale login all mint one
    for (const via of ["local", "tailscale", "token"] as const) expect((await start(owner(via))).status).toBe(200);
    // so does a device already paired with drive rights, and only those
    const paired = store.match(store.pair(store.startPairing().code, "Phone", "drive")!.token)!;
    expect((await start({ level: "full", via: "device", role: "drive", device: paired })).status).toBe(200);
    // the open-LAN opt-in is the one accepted exception: its peers already hold every
    // terminal, and pairing from the LAN is what the mode is for
    expect((await start({ level: "full", via: "open", role: "drive" })).status).toBe(200);
  });

  it("still refuses a session that reached the start without drive rights", async () => {
    // The gate in index.ts answers a session like this before the handler runs, so this is the
    // floor the check holds if one ever reaches it, not a path that runs today. A watch device,
    // the one full session that is not an owner, is answered read_only just above the check.
    const refused = await start({ level: "none", reason: "token_required" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "not_owner", message: "Start pairing from this PC, or with the token" } });
    const watch = store.match(store.pair(store.startPairing().code, "Tablet", "watch")!.token)!;
    const watched = await start({ level: "full", via: "device", role: "watch", device: watch });
    expect(watched.status).toBe(403);
    expect((await watched.json()).error.code).toBe("read_only");
  });

  it("leaves pairing completion public: the code is the secret", async () => {
    const { code } = store.startPairing();
    const completed = await handleDeviceRequest(
      new Request("http://192.168.0.10:7317/api/devices/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: "Phone" }) }),
      "/api/devices/pair",
      store,
      { level: "none", reason: "token_required" },
    );
    expect(completed.status).toBe(204);
    expect(completed.headers.get("set-cookie")).toContain("herdr_web_device=");
  });
});
