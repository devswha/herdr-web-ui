import type { HerdrIdentity } from "../../shared/machines.ts";

/**
 * A terminal attach runs on the PTY sidecar: `node pty-host.mjs`, which imports
 * @lydell/node-pty. A runtime without either (the win32 remote bundle ships Bun alone)
 * cannot start it, whatever herdr itself can do, so its panes stay mirrored.
 */
export interface SidecarRuntime {
  node: () => boolean;
  pty: () => boolean;
}

let realNode: boolean | null = null;

/**
 * `bun run` puts a `node` that is Bun itself first on PATH when the PC has none, and
 * node-pty must not load in Bun (oven-sh/bun#18546): only a `node` that is Node counts.
 */
function nodeOnPath(): boolean {
  if (realNode === null) {
    const found = Bun.which("node");
    if (found === null) return (realNode = false);
    try {
      const asked = Bun.spawnSync([found, "-p", "process.versions.bun ?? ''"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      realNode = asked.success && asked.stdout.toString().trim() === "";
    } catch {
      realNode = false;
    }
  }
  return realNode;
}

const here: SidecarRuntime = {
  node: nodeOnPath,
  pty: () => {
    try {
      Bun.resolveSync("@lydell/node-pty", import.meta.dir);
      return true;
    } catch {
      return false;
    }
  },
};

export function sidecarAvailable(runtime: SidecarRuntime = here): boolean {
  return runtime.pty() && runtime.node();
}

/** herdr's identity as this bridge can serve it: without the sidecar, told the way a herdr that cannot attach tells it. */
export function attachableIdentity(identity: HerdrIdentity, sidecar: boolean): HerdrIdentity {
  if (sidecar || identity.terminal_attach === false) return identity;
  return { ...identity, terminal_attach: false, terminal_mirror: true };
}
