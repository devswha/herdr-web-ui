import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { crossSiteFileRead, fileInfo, fileResponse, locateFileInFolder, pageMediaResponse, pageMediaSource, resolveFilePath } from "./file-view.ts";

describe("file view", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-view-")); roots.push(root); return root; };

  it("resolves absolute, ~ and pane-relative paths", () => {
    expect(resolveFilePath("/a/b.txt", "/work")).toBe("/a/b.txt");
    expect(resolveFilePath("~/x.png", null)).toBe(join(homedir(), "x.png"));
    expect(resolveFilePath("docs/demo.mp4", "/work/app")).toBe("/work/app/docs/demo.mp4");
    expect(resolveFilePath("docs/demo.mp4", null)).toBeNull();
    expect(resolveFilePath("  ", "/work")).toBeNull();
  });

  it("tells media, text and binary apart, and is null for a folder or nothing", () => {
    const root = temp();
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(root, "run.log"), "line\n");
    writeFileSync(join(root, "blob"), Buffer.from([1, 0, 2]));
    writeFileSync(join(root, "notes"), "plain words");
    expect(fileInfo(join(root, "a.png"))!.kind).toBe("image");
    expect(fileInfo(join(root, "run.log"))!.kind).toBe("text");
    expect(fileInfo(join(root, "blob"))!.kind).toBe("binary");
    expect(fileInfo(join(root, "notes"))!.kind).toBe("text");
    expect(fileInfo(root)).toBeNull();
    expect(fileInfo(join(root, "missing"))).toBeNull();
  });

  it("serves HTML as sandboxed plain text, and a download as an attachment", async () => {
    const root = temp();
    writeFileSync(join(root, "page.html"), "<script>alert(1)</script>");
    const response = fileResponse(fileInfo(join(root, "page.html"))!, true);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(response.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("draws an HTML page only when asked to render it, with no origin and no network", async () => {
    const root = temp();
    writeFileSync(join(root, "report.html"), "<p>chart</p>");
    writeFileSync(join(root, "notes.txt"), "<p>not a page</p>");
    const page = fileResponse(fileInfo(join(root, "report.html"))!, false, true);
    expect(page.headers.get("content-type")).toStartWith("text/html");
    const policy = page.headers.get("content-security-policy")!;
    // its script runs, but never with this app's origin, cookie or storage
    expect(policy).toStartWith("sandbox allow-scripts;");
    expect(policy).not.toContain("allow-same-origin");
    // nothing to fetch with: default-src stands in for connect-src
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("connect-src");
    // nor this server's files, whose loading would tell it which exist, nor the web, where a script could send what the page holds
    expect(policy.split("; ").filter((directive) => directive.includes("'self'"))).toEqual(["frame-ancestors 'self'"]);
    expect(policy).not.toContain("http");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(await page.text()).toBe("<p>chart</p>");
    // asked without render, or as a download, it stays the source; another text file never renders
    expect(fileResponse(fileInfo(join(root, "report.html"))!, false).headers.get("content-type")).toStartWith("text/plain");
    expect(fileResponse(fileInfo(join(root, "report.html"))!, true, true).headers.get("content-type")).toStartWith("text/plain");
    const text = fileResponse(fileInfo(join(root, "notes.txt"))!, false, true);
    expect(text.headers.get("content-type")).toStartWith("text/plain");
    expect(text.headers.get("content-security-policy")).toStartWith("sandbox;");
  });

  it("puts a page's own pictures, stylesheet and script into it, and nothing from outside its folder", async () => {
    const root = temp();
    const site = join(root, "site");
    mkdirSync(join(site, "shots"), { recursive: true });
    mkdirSync(join(site, ".ssh"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(site, "shots", "a.png"), png);
    writeFileSync(join(site, "style.css"), "h1 { color: teal }");
    writeFileSync(join(site, "print.css"), "body { display: none }");
    writeFileSync(join(site, "chart.js"), "document.title = 'drawn'; '</script>';");
    writeFileSync(join(site, "config.js"), "const token = 'secret';");
    writeFileSync(join(site, ".ssh", "key.png"), png);
    writeFileSync(join(site, ".env"), "TOKEN=secret");
    writeFileSync(join(site, "notes.txt"), "private notes");
    writeFileSync(join(root, "outside.png"), png);
    symlinkSync(join(root, "outside.png"), join(site, "linked.png"));
    writeFileSync(join(site, "report.html"), [
      `<link rel="stylesheet" href="style.css"><link rel="stylesheet" media="print" href="print.css"><script defer src="./chart.js"></script>`,
      `<script type="text/plain" id="data" src="config.js"></script>`,
      `<img id="shot" src="shots/a.png?v=1">`,
      `<img id="up" src="../outside.png"><img id="link" src="linked.png"><img id="hidden" src=".ssh/key.png">`,
      `<img id="env" src=".env"><img id="text" src="notes.txt"><script id="notjs" src="notes.txt"></script>`,
      `<img id="cdn" src="https://example.com/a.png"><img id="rooted" src="/etc/hosts">`,
      `<img id="unc" src="%5C%5Chost%5Cshare%5Ca.png"><img id="drive" src="C%3A%5Ca.png"><img id="slash" src="%2Fetc%2Fhosts">`,
    ].join(""));
    const html = await fileResponse(fileInfo(join(site, "report.html"))!, false, true).text();
    // its own files, in its folder or below, as the kind of file each element takes, with the element's attributes kept
    const data = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
    expect(html).toContain(`<link rel="stylesheet" href="${data("text/css", "h1 { color: teal }")}">`);
    expect(html).toContain(`<link rel="stylesheet" media="print" href="${data("text/css", "body { display: none }")}">`);
    expect(html).toContain(`<script defer src="${data("text/javascript", "document.title = 'drawn'; '</script>';")}"></script>`);
    expect(html).toContain(`<img id="shot" src="data:image/png;base64,${png.toString("base64")}">`);
    // a script that does not run is a data block: it takes no file, which its neighbour could read
    expect(html).toContain(`<script type="text/plain" id="data" src="config.js"></script>`);
    // nothing above its folder, through a symlink, under a hidden name, or of another kind
    for (const [id, src] of [["up", "../outside.png"], ["link", "linked.png"], ["hidden", ".ssh/key.png"], ["env", ".env"], ["text", "notes.txt"], ["cdn", "https://example.com/a.png"], ["rooted", "/etc/hosts"], ["unc", "%5C%5Chost%5Cshare%5Ca.png"], ["drive", "C%3A%5Ca.png"], ["slash", "%2Fetc%2Fhosts"]]) {
      expect(html).toContain(`<img id="${id}" src="${src}">`);
    }
    expect(html).toContain(`<script id="notjs" src="notes.txt"></script>`);
    expect(html).not.toContain("secret");
    expect(html).not.toContain("private notes");
  });

  it("plays a page's video too large to put into it from an address only its render gives out", async () => {
    const root = temp();
    const site = join(root, "site");
    mkdirSync(join(site, "clips"), { recursive: true });
    mkdirSync(join(site, ".cache"));
    const big = 8 * 1024 * 1024 + 1;
    const sized = (path: string, bytes: number) => { writeFileSync(path, ""); truncateSync(path, bytes); };
    sized(join(site, "big.mp4"), big);
    sized(join(site, "clips", "take.webm"), big);
    sized(join(site, ".cache", "hidden.mp4"), big);
    sized(join(site, "huge.png"), big);
    mkdirSync(join(root, "share", ".private"), { recursive: true });
    sized(join(root, "share", "take.m4a"), big);
    sized(join(root, "share", ".private", "take.mp4"), big);
    sized(join(root, "outside.mp4"), big);
    writeFileSync(join(site, "small.mp4"), "tiny");
    writeFileSync(join(site, "notes.txt"), "private notes");
    // recordings kept elsewhere (a network share), linked beside the report
    symlinkSync(join(root, "share", "take.m4a"), join(site, "linked.m4a"));
    symlinkSync(join(root, "share", ".private", "take.mp4"), join(site, "private.mp4"));
    symlinkSync(join(root, "outside.mp4"), join(site, "elsewhere.mp4"));
    symlinkSync(join(site, "notes.txt"), join(site, "notes.mp4.txt"));
    writeFileSync(join(site, "report.html"), [
      `<video id="big" src="big.mp4" poster="huge.png"></video><video id="again" src="./big.mp4"></video><video id="small" src="small.mp4"></video>`,
      `<video><source id="source" src="clips/take.webm" type="video/webm"></video><audio id="linked" src="linked.m4a"></audio>`,
      `<video id="private" src="private.mp4"></video><video id="elsewhere" src="elsewhere.mp4"></video>`,
      `<audio id="above" src="../share/take.m4a"></audio><video id="abovehidden" src="../share/.private/take.mp4"></video>`,
      `<video id="hidden" src=".cache/hidden.mp4"></video><video id="up" src="../outside.mp4"></video><video id="text" src="notes.mp4.txt"></video>`,
      `<img id="img" src="huge.png"><video id="rooted" src="/etc/hosts"></video>`,
    ].join(""));
    const source = "http://127.0.0.1:7317/api/fs/page-media/";
    const page = fileResponse(fileInfo(join(site, "report.html"))!, false, true, source);
    const policy = page.headers.get("content-security-policy")!;
    // media from that one path, and still nothing else from this server or the web
    expect(policy).toContain(`media-src data: blob: ${source}`);
    expect(policy.split("; ").filter((directive) => directive.includes("http"))).toEqual([`media-src data: blob: ${source}`]);
    const html = await page.text();
    const address = (id: string) => new RegExp(`id="${id}" src="(/api/fs/page-media/[A-Za-z0-9_-]{32})"`).exec(html)?.[1];
    const played = address("big")!;
    expect(played).toBeDefined();
    // one address per file, however it is named
    expect(html).toContain(`<video id="again" src="${played}">`);
    expect(address("source")).toBeDefined();
    // a symlink out of its folder plays nothing: the page could have brought it along to ask whether a file exists
    for (const [id, src] of [["linked", "linked.m4a"], ["private", "private.mp4"], ["elsewhere", "elsewhere.mp4"], ["above", "../share/take.m4a"], ["abovehidden", "../share/.private/take.mp4"]]) {
      expect(html).toContain(`id="${id}" src="${src}"`);
    }
    // what fits is still put into the page; a picture or poster is never played from here
    expect(html).toContain(`<video id="small" src="data:video/mp4;base64,${Buffer.from("tiny").toString("base64")}">`);
    expect(html).toContain(`poster="huge.png"`);
    expect(html).toContain(`<img id="img" src="huge.png">`);
    // nothing under a hidden name, above its folder, of another kind, or rooted
    for (const [id, src] of [["hidden", ".cache/hidden.mp4"], ["up", "../outside.mp4"], ["text", "notes.mp4.txt"], ["rooted", "/etc/hosts"]]) {
      expect(html).toContain(`<video id="${id}" src="${src}">`);
    }
    const media = pageMediaResponse(played.slice("/api/fs/page-media/".length))!;
    expect(media.headers.get("content-type")).toBe("video/mp4");
    expect(media.headers.get("content-security-policy")).toStartWith("sandbox");
    expect(media.headers.get("access-control-allow-origin")).toBeNull();
    expect((await media.arrayBuffer()).byteLength).toBe(big);
    // the same address on the next render, none for a guess, and none once it lapsed
    expect(await fileResponse(fileInfo(join(site, "report.html"))!, false, true, source).text()).toContain(`<video id="big" src="${played}"`);
    expect(pageMediaResponse("A".repeat(32))).toBeNull();
    // the address serves the file its render checked, not what later took its place
    const swapped = address("source")!.slice("/api/fs/page-media/".length);
    expect(pageMediaResponse(swapped)).not.toBeNull();
    rmSync(join(site, "clips"), { recursive: true });
    mkdirSync(join(root, "elsewhere"));
    sized(join(root, "elsewhere", "take.webm"), big);
    symlinkSync(join(root, "elsewhere"), join(site, "clips"));
    expect(pageMediaResponse(swapped)).toBeNull();
    expect(pageMediaResponse(played.slice("/api/fs/page-media/".length), Date.now() + 13 * 60 * 60 * 1000)).toBeNull();
    // ...unless it leads into a folder the operator named, and then not under a hidden name there
    const before = process.env["HERDR_WEB_MEDIA_ROOTS"];
    process.env["HERDR_WEB_MEDIA_ROOTS"] = ["/nonexistent-share", join(root, "share")].join(delimiter);
    try {
      const shared = await fileResponse(fileInfo(join(site, "report.html"))!, false, true, source).text();
      expect(shared).toMatch(/<audio id="linked" src="\/api\/fs\/page-media\/[A-Za-z0-9_-]{32}">/);
      // there it decides where the file lies, however the page reaches it, never under a hidden name or elsewhere above
      expect(shared).toMatch(/<audio id="above" src="\/api\/fs\/page-media\/[A-Za-z0-9_-]{32}">/);
      expect(shared).toContain(`<video id="abovehidden" src="../share/.private/take.mp4">`);
      expect(shared).toContain(`<video id="up" src="../outside.mp4">`);
      expect(shared).toContain(`<video id="private" src="private.mp4">`);
      expect(shared).toContain(`<video id="elsewhere" src="elsewhere.mp4">`);
    } finally {
      if (before === undefined) delete process.env["HERDR_WEB_MEDIA_ROOTS"];
      else process.env["HERDR_WEB_MEDIA_ROOTS"] = before;
    }
    // without a media source (a PC's bridge, a Host that is not plain) the page is drawn as before
    expect(await fileResponse(fileInfo(join(site, "report.html"))!, false, true).text()).toContain(`<video id="big" src="big.mp4"`);
  });

  it("seeks a page's video by Range", async () => {
    const root = temp();
    writeFileSync(join(root, "clip.mp4"), Buffer.alloc(9 * 1024 * 1024, 7));
    writeFileSync(join(root, "page.html"), `<video src="clip.mp4"></video>`);
    const html = await fileResponse(fileInfo(join(root, "page.html"))!, false, true, "http://127.0.0.1:1/api/fs/page-media/").text();
    const token = /page-media\/([A-Za-z0-9_-]{32})/.exec(html)![1]!;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => pageMediaResponse(token) ?? new Response(null, { status: 404 }) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { range: "bytes=100-109" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 100-109/${9 * 1024 * 1024}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(10).fill(7));
    } finally { server.stop(true); }
  });

  it("allows media only from the host the browser asked by", () => {
    expect(pageMediaSource("127.0.0.1:7317", false)).toBe("http://127.0.0.1:7317/api/fs/page-media/");
    expect(pageMediaSource("pc.tailnet.ts.net", true)).toBe("https://pc.tailnet.ts.net/api/fs/page-media/");
    expect(pageMediaSource("[::1]:7317", false)).toBe("http://[::1]:7317/api/fs/page-media/");
    // a Host that could write a directive of its own into the policy is no source at all
    for (const host of [null, "", "a b", "evil; script-src *", "host/path", "host:7317 'unsafe-inline'", "host,other"]) expect(pageMediaSource(host, false)).toBeNull();
  });

  it("resolves a page's URLs once each, and only so many", async () => {
    const root = temp();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(root, "a.png"), png);
    const many = Array.from({ length: 1_000 }, (_, i) => `<img src="missing-${i}.png">`).join("");
    writeFileSync(join(root, "same.html"), `${"<img src=\"missing.png\">".repeat(5_000)}<img id="last" src="a.png">`);
    writeFileSync(join(root, "many.html"), `${many}<img id="last" src="a.png">`);
    const started = performance.now();
    expect(await fileResponse(fileInfo(join(root, "same.html"))!, false, true).text()).toContain(`<img id="last" src="data:image/png;base64,`);
    expect(performance.now() - started).toBeLessThan(2_000);
    // the thousand-and-first URL is left as it is
    expect(await fileResponse(fileInfo(join(root, "many.html"))!, false, true).text()).toContain(`<img id="last" src="a.png">`);
  });

  it("refuses another site's page loading a file, but not a navigation or this app", () => {
    const ask = (headers: Record<string, string>) => crossSiteFileRead(new Request("http://localhost/api/fs/file?path=/x", { headers }));
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" })).toBe(true);
    expect(ask({ "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" })).toBe(true);
    // a new tab, a download or Android's PDF "Open" button is a navigation from anywhere
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).toBe(false);
    expect(ask({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" })).toBe(false);
    expect(ask({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).toBe(false);
    // a browser that sends no Fetch Metadata is let through as before
    expect(ask({})).toBe(false);
  });
});

describe("locateFile", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("refuses parent traversal outside the Claude scratch fallback folder", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    writeFileSync(join(root, "outside.txt"), "outside");
    expect(locateFileInFolder("../outside.txt", folder)).toBeNull();
  });

  it("resolves an in-folder Claude scratch fallback link", () => {
    const folder = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(folder);
    mkdirSync(join(folder, "scratchpad"));
    const path = join(folder, "scratchpad", "notes.txt");
    writeFileSync(path, "notes");
    expect(locateFileInFolder("scratchpad/notes.txt", folder)).toMatchObject({ info: { path } });
  });

  it("refuses absolute paths and symlink escapes from the scratch fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    const folder = join(root, "session");
    mkdirSync(folder);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(folder, "linked.txt"));
    expect(locateFileInFolder(outside, folder)).toBeNull();
    expect(locateFileInFolder("linked.txt", folder)).toBeNull();
  });

  it("finds a bare name deeper in the pane's folder, and lists several of that name", async () => {
    const { mkdirSync } = await import("node:fs");
    const { locateFile } = await import("./file-view.ts");
    const { clearFileCache } = await import("./files.ts");
    const root = mkdtempSync(join(tmpdir(), "herdr-locate-")); roots.push(root);
    mkdirSync(join(root, "docs/screenshots"), { recursive: true });
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    writeFileSync(join(root, "docs/screenshots/demo.mp4"), "x");
    writeFileSync(join(root, "a/notes.md"), "a");
    writeFileSync(join(root, "b/notes.md"), "b");
    clearFileCache();
    expect(locateFile("demo.mp4", root)).toMatchObject({ info: { path: join(root, "docs/screenshots/demo.mp4") } });
    expect(locateFile("screenshots/demo.mp4", root)).toMatchObject({ info: { name: "demo.mp4" } });
    expect(locateFile("notes.md", root)).toEqual({ candidates: [join(root, "a/notes.md"), join(root, "b/notes.md")] });
    expect(locateFile("missing.txt", root)).toBeNull();
    // an absolute or ~ path is taken as written, never searched for
    expect(locateFile("/nowhere/demo.mp4", root)).toBeNull();
  });
});
