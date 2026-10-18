import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { bundleFile, bundleManifestSource } from "./remote-bundle.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform: string) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-bundle-source-")); roots.push(directory);
  const bytes = Buffer.from(`private runtime for ${platform}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, "bundle.tgz"), bytes);
  const manifest = join(directory, `manifest-${platform}.json`);
  writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: "bundle.tgz", sha256 } } }));
  return { directory, manifest, bytes, sha256 };
}

describe("remote bundle sources", () => {
  it("installs each Mac architecture from local manifests without a published release", async () => {
    for (const platform of ["darwin-arm64", "darwin-x64"]) {
      const { directory, manifest, bytes, sha256 } = fixture(platform);
      const options = { directory, manifest: "" }; // Explicitly test automatic discovery, independent of the test runner's environment.
      expect(await bundleManifestSource(platform, options)).toBe(manifest);
      const asset = await bundleFile(platform, new AbortController().signal, options);
      expect(readFileSync(asset.path)).toEqual(bytes);
      expect(asset.size).toBe(bytes.length);
      expect(asset.sha256).toBe(sha256);
    }
  });

  it("keeps explicit manifest configuration ahead of automatic discovery", async () => {
    const local = fixture("darwin-arm64");
    const override = fixture("darwin-arm64");
    expect(await bundleManifestSource("darwin-arm64", { directory: local.directory, manifest: override.manifest })).toBe(override.manifest);
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory: local.directory, manifest: join(local.directory, "missing.json") })).rejects.toThrow("ENOENT");
  });

  it("keeps source-root local bundles available when a managed release runs elsewhere", async () => {
    const { directory, bytes } = fixture("linux-x64");
    const source = join(directory, "source");
    mkdirSync(join(source, "remote-bundles"), { recursive: true });
    for (const name of ["manifest-linux-x64.json", "bundle.tgz"]) cpSync(join(directory, name), join(source, "remote-bundles", name));
    const release = join(directory, "release");
    mkdirSync(join(release, "server"), { recursive: true });
    mkdirSync(join(release, "shared"));
    cpSync(join(import.meta.dir, "remote-bundle.ts"), join(release, "server", "remote-bundle.ts"));
    for (const name of ["machines.ts", "distribution.ts"]) cpSync(join(import.meta.dir, "..", "shared", name), join(release, "shared", name));
    const previous = process.env["HERDR_WEB_SOURCE_ROOT"];
    process.env["HERDR_WEB_SOURCE_ROOT"] = source;
    try {
      const staged = await import(join(release, "server", "remote-bundle.ts"));
      expect(await staged.bundleManifestSource("linux-x64")).toBe(join(source, "remote-bundles", "manifest-linux-x64.json"));
      expect(readFileSync((await staged.bundleFile("linux-x64", new AbortController().signal)).path)).toEqual(bytes);
      // Explicit fixture injection wins, even when a managed source root is present.
      expect(await staged.bundleManifestSource("linux-x64", { directory })).toBe(join(directory, "manifest-linux-x64.json"));
      process.env["HERDR_WEB_SOURCE_ROOT"] = "relative/source";
      await expect(staged.bundleManifestSource("linux-x64")).rejects.toThrow("must be absolute");
    } finally {
      if (previous === undefined) delete process.env["HERDR_WEB_SOURCE_ROOT"]; else process.env["HERDR_WEB_SOURCE_ROOT"] = previous;
    }
  });

  it("uses the release only when the requested platform has no local manifest", async () => {
    const { directory } = fixture("linux-x64");
    expect(await bundleManifestSource("darwin-arm64", { directory, manifest: "" })).toBe(`https://github.com/tomrutsaert/herdr-web-ui/releases/download/fork-remote-v${REMOTE_BUNDLE_VERSION}/manifest.json`);
    await expect(bundleManifestSource("../linux-x64", { directory })).rejects.toThrow("Unsupported bundle platform");
  });

  it("rejects a release manifest that points outside this fork's runtime tag", async () => {
    const { directory, manifest, sha256 } = fixture("linux-x64");
    rmSync(manifest); // Force the release-source path, not local discovery.
    const original = globalThis.fetch;
    try {
      for (const url of [
        `https://github.com/tomrutsaert/herdr-web-ui/releases/download/remote-v${REMOTE_BUNDLE_VERSION}/bundle.tgz`,
        `https://github.com/tomrutsaert/herdr-web-ui/releases/download/fork-remote-v${REMOTE_BUNDLE_VERSION}/../remote-v1/bundle.tgz`,
        `https://github.com/devswha/herdr-web-ui/releases/download/remote-v${REMOTE_BUNDLE_VERSION}/bundle.tgz`,
      ]) {
        globalThis.fetch = (async () => Response.json({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url, sha256 } } })) as unknown as typeof fetch;
        await expect(bundleFile("linux-x64", new AbortController().signal, { directory })).rejects.toThrow("outside this fork release");
        writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url, sha256 } } }));
        await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest })).rejects.toThrow("outside this fork release");
        rmSync(manifest);
      }
    } finally { globalThis.fetch = original; }
  });

  it("rejects corrupted local bytes instead of silently falling back to another source", async () => {
    const { directory } = fixture("darwin-arm64");
    writeFileSync(join(directory, "bundle.tgz"), "changed after manifest creation");
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("checksum mismatch");
  });

  it("rejects incompatible manifests, path traversal and cancelled setup", async () => {
    const { directory, manifest, sha256 } = fixture("darwin-arm64");
    const options = { directory, manifest: "" };
    writeFileSync(manifest, JSON.stringify({ version: "incompatible", assets: {} }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("version mismatch");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "darwin-arm64": { url: "../bundle.tgz", sha256 } } }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("Bundle URL must use HTTPS");
    const controller = new AbortController(); controller.abort(new Error("test cancelled"));
    await expect(bundleFile("darwin-arm64", controller.signal, options)).rejects.toThrow("test cancelled");
  });

  it("reuses a cached release bundle by checksum and never trusts a changed one", async () => {
    const { directory, manifest, bytes, sha256 } = fixture("linux-x64");
    // Only the cache or the offline fetch stand-in can answer; no real release requests.
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url: `https://github.com/tomrutsaert/herdr-web-ui/releases/download/fork-remote-v${REMOTE_BUNDLE_VERSION}/bundle.tgz`, sha256 } } }));
    const cacheDir = join(directory, "cache"); mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, `${sha256}.tgz`), bytes);
    const options = { directory, manifest: "", cacheDir };
    const cached = await bundleFile("linux-x64", new AbortController().signal, options);
    expect(cached.path).toBe(join(cacheDir, `${sha256}.tgz`));
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("fixture offline"); }) as unknown as typeof fetch;
    try {
      writeFileSync(join(cacheDir, `${sha256}.tgz`), "tampered");
      await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toThrow("fixture offline");
      await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("No bundle cache directory");
    } finally { globalThis.fetch = original; }
  });
});
