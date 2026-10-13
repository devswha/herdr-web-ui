import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixedSleepCounts, fixedSleeps, sleepFiles } from "./fixed-sleeps.ts";
import { fail, files, lineOf, read, repo, stripComments } from "./source-scan.ts";

// Repo-wide rules from AGENTS.md that used to be prose only. Each failure says what to change;
// client rules are in src/conventions.test.ts, server rules in server/conventions.test.ts.

const SOURCES = [...files("{src,server,shared,scripts,site,telemetry}/**/*.{ts,tsx,mjs,js}"), "vite.config.ts"];

/** Module specifiers of static imports and re-exports, side-effect imports and `import("…")` with a literal. */
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

describe("imports", () => {
  it("name relative modules with their extension and never use the @shared alias", () => {
    const offenders = SOURCES.flatMap((file) => {
      const code = stripComments(read(file));
      return [...code.matchAll(SPECIFIER)].flatMap((match) => {
        const specifier = match[1] ?? match[2] ?? match[3]!;
        const bad = specifier.startsWith("@shared/") || (specifier.startsWith(".") && !/\.(?:ts|tsx|mjs|js|css|json|md|svg|png|woff2|html|txt)(?:\?[\w&=-]*)?$/.test(specifier));
        return bad ? [`${file}:${lineOf(code, match.index)}: ${specifier}`] : [];
      });
    });
    fail(offenders, "Imports carry explicit .ts/.tsx extensions and relative paths (AGENTS.md, Code conventions): write \"./x.ts\" or \"../shared/x.ts\", never \"./x\" or \"@shared/x\".");
  });

  it("finds the specifiers", () => {
    const found = (code: string) => [...code.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
    expect(found("import { a } from \"./a.ts\";\nimport type {\n  B,\n} from '../b';\nimport \"./side.css\";\nconst c = await import(\"./c.tsx\");\nexport * from \"./d.ts\";"))
      .toEqual(["./a.ts", "../b", "./side.css", "./c.tsx", "./d.ts"]);
  });
});

describe("fixed sleeps", () => {
  // A ratchet: scripts/fixed-sleeps.json is every file's count of fixed sleeps when this test was
  // added (see scripts/fixed-sleeps.ts for what counts). A file may lose sleeps, never gain one,
  // and a file that is not listed has none.
  const baseline = JSON.parse(read("scripts/fixed-sleeps.json")) as Record<string, number>;

  it("adds no fixed sleep and lowers the baseline when one goes", () => {
    const counts = fixedSleepCounts();
    const grown = Object.entries(counts).filter(([file, count]) => count > (baseline[file] ?? 0));
    fail(grown.flatMap(([file, count]) => [`${file}: ${count} fixed sleeps, baseline ${baseline[file] ?? 0}`, ...fixedSleeps(file).map((line) => `  ${line}`)]),
      "Wait for the condition, not for a set time (AGENTS.md: bounded polls and deadlines, never fixed sleeps): poll in a loop bounded by a deadline (`const deadline = Date.now() + 10_000; while (!done()) { if (Date.now() > deadline) throw new Error(\"…\"); await Bun.sleep(25); }`), or race a timeout against the event (`Promise.race`). A wait that must be fixed (proving that nothing arrives, a settle gap herdr needs) says so with `// fixed wait: <why>` on its line or the line above. Never raise scripts/fixed-sleeps.json.");
    const shrunk = Object.entries(baseline).filter(([file, count]) => (counts[file] ?? 0) < count);
    fail(shrunk.map(([file, count]) => `${file}: ${counts[file] ?? 0} now, baseline ${count}`),
      "Fixed sleeps went away: lower these entries in scripts/fixed-sleeps.json to the counts shown (remove an entry at 0; `bun scripts/fixed-sleeps.ts` prints them all), so they cannot come back.");
  });

  it("lists only files that exist", () => {
    fail(Object.keys(baseline).filter((file) => !existsSync(join(repo, file)) || !sleepFiles().includes(file)),
      "Remove these entries from scripts/fixed-sleeps.json: the files are gone or no longer covered.");
  });

  it("tells a fixed sleep from a bounded poll", () => {
    const found = (code: string) => fixedSleeps("example.ts", code).length;
    expect(found("await Bun.sleep(300);")).toBe(1);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 1500));")).toBe(1);
    expect(found("while (!ready) await Bun.sleep(20);")).toBe(1);
    expect(found("await new Promise((resolve) => setTimeout(resolve, 0));")).toBe(0);
    expect(found("while (!done() && Date.now() < deadline) await Bun.sleep(25);")).toBe(0);
    expect(found("for (let i = 0; i < 40 && !seen(); i++) await Bun.sleep(50);")).toBe(0);
    expect(found("const deadline = Date.now() + 5000;\nwhile (!await check()) {\n  assert.ok(Date.now() < deadline, \"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("for (;;) {\n  if (seen()) break;\n  if (Date.now() > deadline) throw new Error(\"late\");\n  await Bun.sleep(25);\n}")).toBe(0);
    expect(found("await Promise.race([event, Bun.sleep(1000)]);")).toBe(0);
    expect(found("// fixed wait: nothing may arrive in this time\nawait Bun.sleep(NO_SEND_WAIT_MS);")).toBe(0);
    expect(found("async function f() {\n  while (Date.now() < deadline) {\n    const g = async () => { await Bun.sleep(5); };\n  }\n}")).toBe(1);
  });
});

describe("demo transport", () => {
  // Every push to main redeploys the browser demo, whose server is site/demo/transport.ts: an
  // endpoint or WS frame it does not answer is a 404 or a dropped frame there (AGENTS.md,
  // Changing a contract).
  const demo = stripComments(read("site/demo/transport.ts"));
  const exact = new Set([...demo.matchAll(/["'](\/api\/[^"'?]*)["']/g)].map((match) => match[1]!));
  const prefixes = [...demo.matchAll(/\.startsWith\(\s*["'](\/api\/[^"']+)["']\s*\)/g)].map((match) => match[1]!).filter((prefix) => prefix !== "/api/");
  const answered = (route: string) => exact.has(route) || prefixes.some((prefix) => route.startsWith(prefix));

  /** Routes the demo leaves to its catch-all 404. Only remove entries; a new route gets an answer in site/demo/transport.ts. */
  const DEMO_404: Record<string, string> = {
    "/api/auth": "the demo is never locked (/api/health says authenticated), so neither the token form nor sign-out runs",
    "/api/bridge": "a remote PC's bridge endpoint, asked by another server, never by the browser",
    "/api/devices": "Settings → Devices: the demo pairs no devices (listed when this guard was added)",
    "/api/devices/pair": "pairing a device: the demo is never locked, so the pairing form does not run",
    "/api/devices/pair/start": "Settings → Devices: the demo pairs no devices (listed when this guard was added)",
    "/api/pane/conversation/image": "an image in a chat turn: the demo's transcripts carry none (listed when this guard was added)",
    "/api/pane/conversation/tool-output": "a tool call's full output: not part of the demo (listed when this guard was added)",
    "/api/pane/image": "pasting an image: the demo stores no files (listed when this guard was added)",
    "/api/pane/read": "the scrollback read behind a chat with no transcript: the demo answers /api/pane/conversation instead (listed when this guard was added)",
    "/api/pane/selection": "copying a selection across screens: not part of the demo (listed when this guard was added)",
    "/api/preferences": "a 404 turns shared-settings sync off, as on an older server (fetchPreferences, src/lib/api.ts)",
    "/api/updates/check": "the demo's /api/updates says managed: false, so Settings offers no check",
    "/api/updates/install": "the demo's /api/updates says managed: false, so Settings offers no install",
  };
  /** Client frames the demo needs no case for. */
  const DEMO_IGNORES: Record<string, string> = {
    "pty-ack": "the demo has no output flow control to release; its switch's default branch drops it",
  };

  it("answers every /api route the server handles", () => {
    const routes = new Set(files("server/**/*.ts").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file))
      .flatMap((file) => [...stripComments(read(file)).matchAll(/["'`](\/api\/[\w./-]*[\w.-])["'`]/g)].map((match) => match[1]!)));
    expect(routes.size).toBeGreaterThan(60);
    fail([...routes].filter((route) => !answered(route) && !(route in DEMO_404)).sort(),
      "Answer these routes in route() in site/demo/transport.ts (with fixtures from site/demo/fixtures.ts), so the demo does not 404. A route the browser never asks for goes into DEMO_404 in scripts/conventions.test.ts with its reason.");
    fail(Object.keys(DEMO_404).filter((route) => answered(route) || !routes.has(route)),
      "Remove these entries from DEMO_404 in scripts/conventions.test.ts: the demo answers them now, or the server no longer has them.");
  });

  it("handles every WS frame a client sends", () => {
    const protocol = read("shared/protocol.ts");
    const union = protocol.slice(protocol.indexOf("export type ClientMessage ="), protocol.indexOf("export type ServerFeature"));
    const frames = [...union.matchAll(/\|\s*\{\s*type:\s*"([\w-]+)"/g)].map((match) => match[1]!);
    expect(frames.length).toBeGreaterThan(10);
    const cases = new Set([...demo.matchAll(/\bcase\s+"([\w-]+)"\s*:/g)].map((match) => match[1]!));
    fail(frames.filter((frame) => !cases.has(frame) && !(frame in DEMO_IGNORES)),
      "Handle these ClientMessage frames (shared/protocol.ts) in the demo socket's switch in site/demo/transport.ts, answering the way the server would. A frame that needs no answer goes into DEMO_IGNORES in scripts/conventions.test.ts with its reason.");
    fail(Object.keys(DEMO_IGNORES).filter((frame) => cases.has(frame) || !frames.includes(frame)),
      "Remove these entries from DEMO_IGNORES in scripts/conventions.test.ts: the demo handles them now, or the protocol no longer has them.");
  });
});
