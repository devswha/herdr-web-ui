import { afterEach, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientRequestId, RequestLog, requestMethod } from "./request-log.ts";
import { errorResponse, setRequestRoute } from "./http.ts";

const roots: string[] = [];
const writers: RequestLog[] = [];
afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-log-"));
  roots.push(root);
  const writer = new RequestLog(root);
  writers.push(writer);
  const path = join(root, "http-requests.jsonl");
  const records = (): Record<string, unknown>[] => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, writer, path, records };
}

it.skipIf(process.platform === "win32")("preserves an existing state directory's permissions", () => {
  // Given: an operator-selected directory with an existing permission policy.
  const root = mkdtempSync(join(tmpdir(), "herdr-request-permissions-"));
  roots.push(root);
  chmodSync(root, 0o750);
  // When
  const writer = new RequestLog(root);
  writers.push(writer);
  // Then
  expect(statSync(root).mode & 0o777).toBe(0o750);
  expect(statSync(join(root, "http-requests.jsonl")).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("neither follows nor writes a symlinked log path", async () => {
  // Given: the log path is a symlink to another file.
  const root = mkdtempSync(join(tmpdir(), "herdr-request-symlink-"));
  roots.push(root);
  const target = join(root, "untouched.txt");
  writeFileSync(target, "unchanged", { mode: 0o640 });
  symlinkSync(target, join(root, "http-requests.jsonl"));
  // When
  const writer = new RequestLog(root);
  writers.push(writer);
  const response = await writer.handle(new Request("http://localhost/api/preferences"), async () => new Response("still works"));
  // Then: refusing the writer never changes HTTP or the symlink's target.
  expect(await response?.text()).toBe("still works");
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  expect(statSync(target).mode & 0o777).toBe(0o640);
});

it("validates client correlation without trusting uniqueness", async () => {
  // Given: repeated, maximum-length and hostile correlation values.
  const { writer, records } = fixture();
  for (const value of ["", "a".repeat(65), "é", "a b", "a\n", "a\r\nInjected: secret", null]) expect(clientRequestId(value)).toBeUndefined();
  for (const value of ["abc._-123", "a".repeat(64)]) expect(clientRequestId(value)).toBe(value);
  // When: independent requests reuse the same valid client id.
  for (let i = 0; i < 2; i++) await writer.handle(new Request("http://localhost/api/session", { headers: { "x-request-id": "repeated" } }), async () => Response.json({}));
  // Then: the server remains the source of unique ids.
  const rows = records();
  expect(rows.map((row) => row.client_request_id)).toEqual(["repeated", "repeated"]);
  expect(rows[0]?.request_id).not.toBe(rows[1]?.request_id);
  for (const row of rows) {
    expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(row).sort()).toEqual(["client_request_id", "latency_ms", "method", "request_id", "route", "status"]);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  }
});

it("rotates within two one-MiB files", async () => {
  // Given: one writer with enough requests to rotate more than once.
  const { root, writer, path } = fixture();
  const request = new Request("http://localhost/api/session");
  // When
  for (let i = 0; i < 16000; i++) await writer.handle(request, async () => new Response(null, { status: 204 }));
  writer.close();
  // Then: complete bounded JSON lines, private storage and only one previous file.
  for (const file of [path, `${path}.1`]) {
    expect(statSync(file).size).toBeLessThanOrEqual(1024 * 1024);
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(1024);
      expect(JSON.parse(line).status).toBe(204);
    }
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(existsSync(`${path}.2`)).toBe(false);
  if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
  // Shutdown is idempotent, and later completions do not reopen the writer.
  const size = statSync(path).size;
  await writer.handle(request, async () => new Response(null, { status: 204 }));
  expect(statSync(path).size).toBe(size);
});

it("normalizes secret-bearing paths", async () => {
  // Given: a request with private segments, a query and a secret-bearing custom method.
  const { writer, path, records } = fixture();
  expect(requestMethod("private-secret")).toBe("OTHER");
  // When: dispatch labels an operation, or leaves it unmatched; no URL is reconstructed.
  await writer.handle(new Request("http://localhost/api/fs/file?path=/private-secret&token=private-secret"), async () => {
    setRequestRoute("/api/fs/file");
    return new Response(null, { status: 404 });
  });
  await writer.handle(new Request("http://localhost/api/private-secret"), async () => new Response(null, { status: 404 }));
  await writer.handle(new Request("http://localhost/private-secret"), async () => {
    setRequestRoute("static");
    return new Response(null, { status: 404 });
  });
  // Then
  expect(readFileSync(path, "utf8")).not.toContain("private-secret");
  expect(records().map((row) => row.route)).toEqual(["/api/fs/file", "unmatched", "static"]);
});

it("write failure preserves response", async () => {
  // Given: rotation cannot replace a directory at the previous-file path.
  const { root, writer, path } = fixture();
  writer.close();
  writeFileSync(path, "x".repeat(1024 * 1024));
  mkdirSync(`${path}.1`);
  const failing = new RequestLog(root);
  writers.push(failing);
  const response = new Response("unchanged", { headers: { "referrer-policy": "same-origin", "x-content-type-options": "route-value" } });
  // When
  const result = await failing.handle(new Request("http://localhost/api/session"), async () => response);
  // Then
  expect(result).toBe(response);
  expect(await result?.text()).toBe("unchanged");
  expect(result?.headers.get("referrer-policy")).toBe("same-origin");
  expect(result?.headers.get("x-content-type-options")).toBe("route-value");
  expect(result?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

it("correlates caught and uncaught failures without recording exception text", async () => {
  // Given
  const { writer, records, path } = fixture();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    // When: a route catches its error, or lets the boundary catch it.
    for (const caught of [true, false]) {
      const response = await writer.handle(new Request("http://localhost/api/session"), async () => {
        if (caught) return errorResponse(new Error("private exception"));
        throw new Error("private exception");
      });
      // Then
      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { message: `internal error (${response?.headers.get("x-request-id")})` } });
    }
    expect(records()).toHaveLength(2);
    expect(readFileSync(path, "utf8")).not.toContain("private exception");
  } finally { consoleError.mockRestore(); }
});

it("records an upgrade once without turning it into a Response", async () => {
  // Given
  const { writer, records } = fixture();
  // When
  const result = await writer.handle(new Request("http://localhost/ws"), async (headers) => {
    setRequestRoute("/ws");
    expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    return undefined;
  });
  // Then
  expect(result).toBeUndefined();
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({ status: 101, route: "/ws" });
});
