import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

/** The line public/sw.js carries until a build names itself in it. */
const UNSTAMPED = 'const BUILD = "";';

/**
 * A build's name: the hashed files it emits. Vite names every file under assets/ after its
 * contents, so two builds that serve the same files share it and any changed file moves it.
 */
export function buildId(fileNames: Iterable<string>): string {
  const hash = createHash("sha256");
  for (const name of [...fileNames].filter((name) => name.startsWith("assets/")).sort()) hash.update(`${name}\0`);
  return hash.digest("hex").slice(0, 12);
}

/** public/sw.js as one build serves it: its cache named after that build (see BUILD in sw.js). */
export function stampServiceWorker(source: string, build: string): string {
  if (!/^[0-9a-f]+$/.test(build)) throw new Error(`not a build id: ${build}`);
  const at = source.indexOf(UNSTAMPED);
  if (at === -1 || source.indexOf(UNSTAMPED, at + 1) !== -1) throw new Error(`public/sw.js must hold exactly one \`${UNSTAMPED}\` line`);
  return source.replace(UNSTAMPED, `const BUILD = "${build}";`);
}

/**
 * Stamps dist/sw.js with the build, so every build installs a worker whose cache holds only its
 * own files. Vite copies public/ unchanged before the bundle is written, so this runs after.
 */
export function serviceWorkerBuild(): Plugin {
  let build = "";
  return {
    name: "service-worker-build",
    apply: "build",
    generateBundle(_options, bundle) { build = buildId(Object.keys(bundle)); },
    writeBundle(options) {
      const path = options.dir ? join(options.dir, "sw.js") : null;
      if (!path || !existsSync(path)) return;
      writeFileSync(path, stampServiceWorker(readFileSync(path, "utf8"), build));
    },
  };
}
