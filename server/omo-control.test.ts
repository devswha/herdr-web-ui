import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlActivity, OmoControl, readControlState } from "./omo-control.ts";

const root = mkdtempSync(join(tmpdir(), "omo-control-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function endpoint(name: string, response: (request: Record<string, unknown>, socket: Socket) => void) {
  const path = join(root, `${name}.sock`);
  const secret = Buffer.from(Array.from({ length: 32 }, (_, at) => at));
  writeFileSync(`${path}.secret`, secret);
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 32 || !bytes.subarray(32).includes(10)) return;
      expect(bytes.subarray(0, 32)).toEqual(secret);
      const request = JSON.parse(bytes.subarray(32).toString("utf8").trim());
      requests.push(request);
      response(request, socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return { path, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
const frame = (id: unknown, data: unknown) => JSON.stringify({ id, type: "response", command: "get_state", success: true, data }) + "\n";
const state = { sessionId: "mine", isStreaming: false, isCompacting: false, retryAttempt: 0 };

describe("read-only TUI state", () => {
  it("prefers native compaction and retries over streaming and validates required fields", () => {
    expect(controlActivity({ ...state, isStreaming: true, isCompacting: true, retryAttempt: 2 })).toBe("compacting");
    expect(controlActivity({ ...state, isStreaming: true, retryAttempt: 2 })).toBe("retrying");
    expect(controlActivity({ ...state, isStreaming: true })).toBe("working");
    expect(controlActivity(state)).toBe("idle");
    for (const invalid of [{}, { ...state, retryAttempt: -1 }, { ...state, isStreaming: "yes" }])
      expect(controlActivity(invalid)).toBeNull();
  });

  it("authenticates with raw bytes, sends only get_state, and projects no private state", async () => {
    const server = await endpoint("valid", (request, socket) => {
      const answer = frame(request.id, { ...state, isCompacting: true, model: { id: "private" }, steering: ["secret prompt"] });
      socket.write(answer.slice(0, 30));
      socket.end(answer.slice(30));
    });
    try {
      expect(await readControlState(server.path)).toEqual({ sessionId: "mine", activity: "compacting" });
      expect(server.requests).toEqual([{ id: "herdr-progress", type: "get_state" }]);
    } finally { await server.close(); }
  });

  for (const [name, answer] of [
    ["wrong-id", frame("foreign", state)],
    ["wrong-command", JSON.stringify({ id: "herdr-progress", type: "response", command: "wake", success: true, data: state }) + "\n"],
    ["failed", JSON.stringify({ id: "herdr-progress", type: "response", command: "get_state", success: false }) + "\n"],
    ["malformed", "{broken}\n"],
    ["oversized", "x".repeat(1024 * 1024 + 1) + "\n"],
    ["closed", ""],
  ] as const) {
    it(`returns unknown for a ${name} response`, async () => {
      const server = await endpoint(name, (_, socket) => socket.end(answer));
      try { expect(await readControlState(server.path)).toBeNull(); }
      finally { await server.close(); }
    });
  }

  it("rejects a malformed secret without connecting", async () => {
    const path = join(root, "bad-secret.sock");
    writeFileSync(`${path}.secret`, Buffer.alloc(33));
    expect(await readControlState(path)).toBeNull();
  });

  it("closes a silent endpoint at the bounded connection deadline", async () => {
    // Time is the behavior under test: await the client's deadline, not a sleep or poll.
    const server = await endpoint("silent", () => undefined);
    try { expect(await readControlState(server.path)).toBeNull(); }
    finally { await server.close(); }
  });

  it("reuses discovery and session ownership, and never adopts a mismatched socket", async () => {
    const agentDir = join(root, "cache");
    const registry = join(agentDir, "rpc-host-daemon");
    for (const [name, kind, socket] of [
      ["0000000000000001", "tui", "/mine.sock"],
      ["0000000000000002", "tui", "/other.sock"],
      ["0000000000000003", "rpc_host", "/host.sock"],
    ] as const) {
      const dir = join(registry, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ endpoint_kind: kind, socket }));
    }
    let now = 100;
    let switched = false;
    const queried: string[] = [];
    const control = new OmoControl(agentDir, () => now, async (path) => {
      queried.push(path);
      return { sessionId: path === "/mine.sock" && !switched ? "mine" : "other", activity: "working" };
    });
    expect(await control.activity("mine")).toBe("working");
    expect(queried.sort()).toEqual(["/mine.sock", "/other.sock"]);
    queried.length = 0;
    expect(await control.activity("absent")).toBeNull();
    expect(queried).toEqual([]);
    expect(await control.activity("mine")).toBe("working");
    expect(queried).toEqual(["/mine.sock"]);
    switched = true;
    expect(await control.activity("mine")).toBeNull();
    now += 5000;
    expect(await control.activity("mine")).toBeNull();
    expect(await control.activity("other")).toBeNull(); // duplicate identity is ambiguous
  });
});
