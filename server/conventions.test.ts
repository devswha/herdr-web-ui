import { describe, expect, it } from "bun:test";
import { fail, files, lineOf, read, stripComments } from "../scripts/source-scan.ts";

// Server rules from AGENTS.md and server/AGENTS.md that used to be prose only. Each failure says
// what to change; client rules are in src/conventions.test.ts, repo-wide ones in
// scripts/conventions.test.ts.

/** Server code that ships: not tests, not test stand-ins. */
const serverCode = (): string[] => files("server/**/*.{ts,mjs,js}").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file));

/** Every match of `pattern` in each file's code (comments removed), as `file:line: text`. */
function matches(fileList: string[], pattern: RegExp): { file: string; at: string; index: number; code: string }[] {
  return fileList.flatMap((file) => {
    const code = stripComments(read(file));
    return [...code.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].map((match) => {
      const line = lineOf(code, match.index);
      return { file, index: match.index, code, at: `${file}:${line}: ${code.split("\n")[line - 1]!.trim().slice(0, 160)}` };
    });
  });
}

describe("PTY sidecar boundary", () => {
  // node-pty panics Bun (oven-sh/bun#18546): only the Node sidecar loads it. `Bun.resolveSync`
  // in server/pty/sidecar.ts only finds the package for Node and is not a load.
  const NODE_SIDE = new Set(["server/pty/pty-host.mjs", "server/pty/smoke.mjs"]);
  const LOAD = /\bfrom\s*["'](?:@lydell\/)?node-pty[^"']*["']|\bimport\s*\(?\s*["'](?:@lydell\/)?node-pty[^"']*["']|\brequire\s*\(\s*["'](?:@lydell\/)?node-pty[^"']*["']/;

  it("loads node-pty only in the Node sidecar", () => {
    // this file names the package in its own examples
    const code = [...files("{server,src,shared,scripts,site,telemetry}/**/*.{ts,tsx,mjs,cjs,js}"), "vite.config.ts"].filter((file) => file !== "server/conventions.test.ts");
    const loads = matches(code, LOAD);
    fail(loads.filter((load) => !NODE_SIDE.has(load.file)).map((load) => load.at),
      "node-pty must never load inside Bun (AGENTS.md, Bridge invariants). PTY work goes through the Node sidecar server/pty/pty-host.mjs via PtySession (server/pty/session.ts).");
    expect(loads.map((load) => load.file)).toContain("server/pty/pty-host.mjs");
  });

  it("knows an import from a mention", () => {
    expect(LOAD.test("import * as pty from \"@lydell/node-pty\";")).toBe(true);
    expect(LOAD.test("const pty = await import('node-pty')")).toBe(true);
    expect(LOAD.test("Bun.resolveSync(\"@lydell/node-pty\", import.meta.dir);")).toBe(false);
  });
});

describe("web push", () => {
  // web-push's sendNotification goes through node:https, which Bun does not carry the way it
  // needs; push.ts builds each request with generateRequestDetails and sends it with fetch.
  it("never calls sendNotification", () => {
    fail(matches(files("{server,src,shared,scripts,telemetry}/**/*.{ts,tsx,mjs,js}").filter((file) => !file.endsWith(".test.ts")), /\bsendNotification\b/).map((match) => match.at),
      "Web push requests are built with webpush.generateRequestDetails and sent with fetch (server/push.ts); never call sendNotification (AGENTS.md, Bridge invariants).");
  });
});

/** The text of the `{ … }` that opens at `open`, strings respected. */
function braces(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\"" || ch === "'" || ch === "`") {
      for (i += 1; i < code.length && code[i] !== ch; i += code[i] === "\\" ? 2 : 1);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

describe("error bodies", () => {
  // Every error body is `{ error: { code, message } }` (AGENTS.md, Changing a contract): the
  // client reads `code` to decide and shows `message`. JSON answers go through jsonResponse or
  // its wrappers in server/http.ts, so the content type and the envelope stay one shape.
  it("builds JSON answers only through server/http.ts", () => {
    fail(matches(serverCode().filter((file) => file !== "server/http.ts"), /\bResponse\.json\s*\(|new Response\s*\(\s*JSON\.stringify/).map((match) => match.at),
      "Answer JSON with jsonResponse, errorResponse, badRequest or conflictResponse from server/http.ts, not Response.json or new Response(JSON.stringify(…)).");
  });

  /** An answer whose body opens with `error`: the first argument of jsonResponse or of a local wrapper around it (`reply`, `fail`). */
  const ERROR_BODY = /\b(?:jsonResponse|reply|fail)\s*\(\s*\{\s*error\s*:\s*/;
  const malformed = (code: string, at: number): boolean => {
    const value = code.slice(at).replace(ERROR_BODY, "");
    if (!value.startsWith("{")) return true;
    const body = braces(value, 0);
    return !/\bcode\b/.test(body) || !/\bmessage\b/.test(body);
  };

  it("gives every error body both a code and a message", () => {
    const bodies = matches(serverCode(), ERROR_BODY);
    expect(bodies.length).toBeGreaterThan(30);
    fail(bodies.filter((match) => malformed(match.code, match.index)).map((match) => match.at),
      "An error body is { error: { code, message } } with a snake_case code: use badRequest(code, message) or conflictResponse(code, message) from server/http.ts, errorResponse(error) for a thrown error, or jsonResponse({ error: { code, message } }, status) for another status.");
  });

  it("reads an error body's shape", () => {
    expect(malformed("return jsonResponse({ error: \"nope\" }, 400);", 7)).toBe(true);
    expect(malformed("return reply({ error: { code: \"x\" } }, 400);", 7)).toBe(true);
    expect(malformed("return jsonResponse({ error: { code, message: a ? b : \"c\" } }, 503);", 7)).toBe(false);
    expect(ERROR_BODY.test("this.patch({ phase: \"error\", error: \"failed\" });")).toBe(false);
  });
});

describe("herdr socket", () => {
  // herdr closes the socket after each answer, so every RPC opens its own connection in
  // server/herdr/client.ts (no pooling), and only server/collector.ts holds a status
  // subscription (AGENTS.md, Bridge invariants).
  const UNIX_CONNECT_ALLOWED: Record<string, string> = {
    "server/herdr/client.ts": "the one herdr RPC client: one connection per call, plus subscribeEvents",
    "server/herdr-marker.ts": "a liveness probe: connects and ends at once, sends no request",
  };
  const NET_CONNECT_ALLOWED: Record<string, string> = {
    "server/ssh-askpass.ts": "the SSH askpass helper's own private socket, not herdr's",
  };

  it("opens herdr's socket only in server/herdr/client.ts", () => {
    const unix = matches(serverCode(), /\bBun\.connect\s*(?:<[^>]*>)?\s*\(/).filter((match) => /\bunix\s*:/.test(braces(match.code, match.code.indexOf("{", match.index))));
    const net = matches(serverCode(), /\bimport\s*\{[^}]*\b(?:connect|createConnection)\b[^}]*\}\s*from\s*["'](?:node:)?net["']/);
    expect(unix.map((match) => match.file)).toContain("server/herdr/client.ts");
    fail([
      ...unix.filter((match) => !(match.file in UNIX_CONNECT_ALLOWED)).map((match) => match.at),
      ...net.filter((match) => !(match.file in NET_CONNECT_ALLOWED)).map((match) => match.at),
    ], "Call herdr through the helpers in server/herdr/client.ts (herdrRpc and the named wrappers): one connection per call, never a pooled or second client. A socket that is not herdr's needs an entry with its reason in server/conventions.test.ts.");
  });

  it("subscribes to status only in server/collector.ts", () => {
    const subscribers = matches(serverCode(), /\bsubscribeEvents\b/).filter((match) => match.file !== "server/herdr/client.ts" && match.file !== "server/collector.ts");
    const raw = matches(files("{server,src,shared,scripts}/**/*.{ts,tsx,mjs,js}").filter((file) => !file.endsWith(".test.ts")), /["']events\.subscribe["']/).filter((match) => match.file !== "server/herdr/client.ts");
    fail([...subscribers, ...raw].map((match) => match.at),
      "server/collector.ts is the only status subscription (startStatusCollector): take pane status from its callbacks (onStatus, onPaneEnded, onBaseline) in server/index.ts instead of subscribing again.");
  });
});
