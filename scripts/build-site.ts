/**
 * Assembles the website into _site/ for GitHub Pages (.github/workflows/pages.yml) and for a local
 * look (`bun run build:site`, then serve _site/ under /herdr-web-ui/).
 *
 * The page is site/index.html. Its demo videos and screenshots are published under media/ and assets/.
 * The videos are not committed (docs/development.md, "README media"), so a build uses the local
 * docs/screenshots/*.mp4 when they exist and otherwise downloads their GitHub uploads (`videos`).
 * Poster frames are cut with ffmpeg when it is installed (the workflow installs it); without it the
 * stills stay full size and posters that could not be made are dropped from the page.
 *
 * demo/ is the app itself, built by Vite with relative asset paths into demo/app/, loaded behind
 * site/demo/transport.ts (bundled to demo-transport.js and injected before the app's scripts) so it
 * runs on the fixtures in site/demo/ instead of a server; site/demo/index.html frames it with a
 * banner. Building it needs node_modules (`bun install`).
 *
 * site/assets/ (stills, logo marks, grain) and site/media/ (the film and the hero loop, with their
 * posters) are committed already optimised and copied whole, preserving the film URL linked from
 * the README. A missing film/loop poster is cut from its video when ffmpeg can; references to missing
 * film/loop files are removed if a page uses them. The homepage uses the two demo videos above.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");

const copies: Array<[from: string, to: string]> = [
  ["site/index.html", "index.html"],
  // the one-line installer: curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
  ["install.sh", "install.sh"],
  ["public/favicon.ico", "favicon.ico"],
  ["public/favicon.png", "favicon.png"],
  ["public/apple-touch-icon.png", "apple-touch-icon.png"],
  ["public/icons/icon-192.png", "assets/icon-192.png"],
  ["public/social-preview.png", "assets/social-preview.png"],
];

/** README stills, scaled down for the page when ffmpeg is there (they are 2x captures of a 1512px window). */
const stills: Array<{ file: string; width: number }> = [
  { file: "desktop-chat.png", width: 1600 },
  { file: "desktop-terminal.png", width: 1600 },
  { file: "desktop-prompt.png", width: 1600 },
  { file: "mobile-chat.png", width: 640 },
  { file: "mobile-terminal.png", width: 640 },
  { file: "mobile-sessions.png", width: 640 },
];

/**
 * The homepage's two demos and their GitHub uploads (made by scripts/readme-media/capture.ts). They are
 * listed here, not read from the README, so the README can change how it presents its videos.
 */
const videos: Array<{ file: string; poster: string; at: string; upload: string }> = [
  { file: "demo-desktop.mp4", poster: "demo-desktop.jpg", at: "6", upload: "https://github.com/user-attachments/assets/4ca73671-ebfc-4c18-b8f2-99331abf9fa7" },
  { file: "demo-mobile.mp4", poster: "demo-mobile.jpg", at: "5", upload: "https://github.com/user-attachments/assets/2f030569-1004-425e-835d-9e775ec6e4c8" },
];

async function run(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) console.warn(`${cmd[0]} failed (${code}): ${await new Response(proc.stderr).text()}`.trim());
  return code === 0;
}

// size guard, before anything is removed: the page's media and stills are committed, so they must stay small
const MB = 1024 * 1024;
const caps: Record<string, (file: string) => number> = {
  "site/media": (file) => (file === "herdr-web-ui-film.mp4" ? 24 : 4) * MB,
  "site/assets": () => 0.75 * MB,
};
for (const [dir, cap] of Object.entries(caps)) {
  const from = join(root, dir);
  for (const file of existsSync(from) ? readdirSync(from, { recursive: true, encoding: "utf8" }) : []) {
    const stat = statSync(join(from, file));
    if (stat.isFile() && stat.size > cap(file)) throw new Error(`${dir}/${file} is ${(stat.size / MB).toFixed(2)} MB, over its ${cap(file) / MB} MB cap`);
  }
}

rmSync(out, { recursive: true, force: true });
for (const [from, to] of copies) {
  const target = join(out, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}
writeFileSync(join(out, ".nojekyll"), "");

// committed page assets and media, copied as they are
for (const dir of ["assets", "media"]) {
  const from = join(root, "site", dir);
  if (existsSync(from)) cpSync(from, join(out, dir), { recursive: true });
}

const hasFfmpeg = Bun.which("ffmpeg") !== null;
for (const still of stills) {
  const from = join(root, "docs/screenshots", still.file);
  const target = join(out, "assets", still.file);
  if (!hasFfmpeg || !(await run(["ffmpeg", "-v", "error", "-y", "-i", from, "-vf", `scale=${still.width}:-1`, target]))) copyFileSync(from, target);
}

mkdirSync(join(out, "media"), { recursive: true });
for (const video of videos) {
  const target = join(out, "media", video.file);
  const local = join(root, "docs/screenshots", video.file);
  if (existsSync(local)) {
    copyFileSync(local, target);
  } else {
    const response = await fetch(video.upload, { redirect: "follow" });
    if (!response.ok) throw new Error(`${video.upload}: HTTP ${response.status}`);
    writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  }
  const poster = join(out, "media", video.poster);
  if (!hasFfmpeg || !(await run(["ffmpeg", "-v", "error", "-y", "-ss", video.at, "-i", target, "-frames:v", "1", "-q:v", "3", poster]))) {
    // no poster file: the page must not ask for one
    const page = join(out, "index.html");
    writeFileSync(page, readFileSync(page, "utf8").replace(` poster="media/${video.poster}"`, ""));
  }
}

// the page's own media: cut a missing poster from its video, then unlink whatever is still missing
const pageMedia = ["herdr-web-ui-film", "chat-loop"];
let page = readFileSync(join(out, "index.html"), "utf8");
for (const name of pageMedia) {
  const video = join(out, "media", `${name}.mp4`);
  const poster = join(out, "media", `${name}.jpg`);
  if (existsSync(video) && !existsSync(poster) && hasFfmpeg) await run(["ffmpeg", "-v", "error", "-y", "-i", video, "-frames:v", "1", "-q:v", "3", poster]);
  for (const [file, attrs] of [[video, "src|data-src"], [poster, "poster|data-poster"]] as const) {
    if (existsSync(file)) continue;
    console.warn(`site/media/${file.split("/").pop()} is missing: the page shows its still instead`);
    page = page.replace(new RegExp(` (?:${attrs})="media/${file.split("/").pop()!.replace(".", "\\.")}"`, "g"), "");
  }
}
writeFileSync(join(out, "index.html"), page);

// the demo: the real client, relative paths, the transport in front of it
const demoApp = join(out, "demo", "app");
if (!(await run([join(root, "node_modules/.bin/vite"), "build", "--base", "./", "--outDir", demoApp, "--emptyOutDir", "--logLevel", "warn"]))) throw new Error("vite build for the demo failed");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const bundle = await Bun.build({
  entrypoints: [join(root, "site/demo/transport.ts")],
  outdir: demoApp,
  naming: "demo-transport.js",
  target: "browser",
  minify: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
});
if (!bundle.success) throw new Error(`demo transport bundle failed:\n${bundle.logs.map(String).join("\n")}`);
const appPage = join(demoApp, "index.html");
let html = readFileSync(appPage, "utf8");
// Vite leaves the PWA links root-absolute; on Pages the root is another site. The manifest goes:
// the demo is not an app to install (its scope and start_url name a root that is not it).
html = html.replace(/\s*<link rel="manifest"[^>]*>/, "");
html = html.replace(/(href|src)="\/(?!\/)/g, '$1="./');
html = html.replace(/<meta name="viewport"/, '<meta name="robots" content="noindex" />\n    <meta name="viewport"');
if (!/<script type="module"/.test(html)) throw new Error("the built app has no module script to load the demo transport before");
html = html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"');
writeFileSync(appPage, html);
// the brand mark is <img src="/icons/…"> in the client (src/App.tsx, AccessGate.tsx): root-absolute,
// which is right for the app at its own origin and wrong under demo/app/
for (const script of new Bun.Glob("assets/*.js").scanSync({ cwd: demoApp })) {
  const file = join(demoApp, script);
  writeFileSync(file, readFileSync(file, "utf8").replaceAll('"/icons/', '"./icons/'));
}
copyFileSync(join(root, "site/demo/index.html"), join(out, "demo", "index.html"));

const files = new Bun.Glob("**/*").scanSync({ cwd: out, dot: true });
let bytes = 0;
for (const file of files) bytes += Bun.file(join(out, file)).size;
console.log(`_site: ${(bytes / 1024 / 1024).toFixed(1)} MB${hasFfmpeg ? "" : " (no ffmpeg: full-size stills, videos without posters)"}`);
