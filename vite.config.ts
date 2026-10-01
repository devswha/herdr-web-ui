import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

let revision: string | null = null;
try { revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* non-Git build */ }

// agentSvgMarks.ts carries LobeHub Icons paths (MIT): their notice ships with every built client
const thirdPartyNotices: Plugin = {
  name: "third-party-notices",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.md", source: readFileSync("THIRD_PARTY_NOTICES.md", "utf8") });
  },
};

export default defineConfig({
  plugins: [react(), thirdPartyNotices],
  define: {
    __APP_REVISION__: JSON.stringify(revision),
    __APP_VERSION__: JSON.stringify((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7317",
      "/ws": { target: "ws://localhost:7317", ws: true },
    },
  },
  build: { outDir: "dist" },
  resolve: { alias: { "@shared": new URL("./shared", import.meta.url).pathname } },
});
