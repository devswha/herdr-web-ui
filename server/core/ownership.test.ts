import { expect, it } from "bun:test";
import { posix } from "node:path";
import { fail, files, lineOf, read, stripComments } from "../../scripts/source-scan.ts";

// The core's modules hand each other the objects they own by reference (server/core/index.ts): code
// outside server/core reaches them only through that index, and the index exports only createCore and
// what the WebSocket upgrade needs.

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

it("is reached from outside only through server/core/index.ts", () => {
  const outside = files("{server,src,shared,scripts,site,telemetry,app}/**/*.{ts,tsx,mts,mjs,cjs,js}").filter((file) => !file.startsWith("server/core/"));
  const reaching = outside.flatMap((file) => {
    const code = stripComments(read(file));
    return [...code.matchAll(SPECIFIER)].flatMap((match) => {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) return [];
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      return target.startsWith("server/core/") && target !== "server/core/index.ts" ? [`${file}:${lineOf(code, match.index)}: ${specifier}`] : [];
    });
  });
  fail(reaching, "Import the core from server/core/index.ts. Its modules share the state they own by reference; reaching one from outside lets that state be held or changed where its owner does not look.");
  expect(outside).toContain("server/index.ts");
});

it("exports only createCore and the WebSocket's data from server/core/index.ts", () => {
  const code = stripComments(read("server/core/index.ts"));
  const statements = [...code.matchAll(/\bexport\b[^;]*;/g)].map((match) => match[0]);
  const names = statements.flatMap((statement) => {
    const list = /^export\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];$/.exec(statement.replace(/\s+/g, " "));
    return list ? list[1]!.split(",").map((name) => name.trim().replace(/^type\s+/, "")) : [`(not a named re-export) ${statement}`];
  });
  expect(names.sort()).toEqual(["SocketData", "connectionData", "createCore"]);
});
