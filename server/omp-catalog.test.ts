import { expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import * as ompProbe from "./omp-process.ts";

// Keep the retired catalog's regression coverage at its caller: an unwritten conversation
// must neither run discovery (which can refresh OAuth) nor execute a replaced launcher path.
for (const swapped of [false, true]) it.skipIf(process.platform !== "linux")(
  swapped ? "never executes a replaced absolute launcher while reading an unwritten omp session" : "never starts OAuth-capable catalog discovery for an unwritten omp session",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-no-omp-catalog-"));
    const store = join(root, ".omp/agent/sessions/project");
    mkdirSync(store, { recursive: true });
    const session = join(store, "2026-10-19_unwritten.jsonl");
    const script = join(root, "omp");
    const launcher = swapped ? join(root, "bun") : process.execPath;
    const marker = join(root, "listed");
    const listing = JSON.stringify({ models: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }] });
    writeFileSync(script, `if (process.argv.includes("models")) { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "listed"); console.log(${JSON.stringify(listing)}); } else { console.log("ready"); process.stdin.resume(); }`);
    if (swapped) symlinkSync(process.execPath, launcher);
    const child = Bun.spawn([launcher, script], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const savedHome = process.env["HOME"];
    const restores: Array<() => void> = [];
    try {
      await child.stdout.getReader().read();
      const executable = readlinkSync(`/proc/${child.pid}/exe`);
      if (swapped) {
        unlinkSync(launcher);
        writeFileSync(launcher, `#!/bin/sh\nprintf listed > "${marker}"\nprintf '%s\\n' '${listing}'\n`, { mode: 0o755 });
      }
      process.env["HOME"] = root;
      const pane = { pane_id: "unwritten-omp", cwd: root, foreground_cwd: root, agent: "omp", agent_status: "idle" } as HerdrPane;
      const foreground = [{ pid: child.pid, argv: [launcher, script] }];
      const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane] } as SessionSnapshot);
      const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => (method === "agent.get"
        ? { agent: { agent_session: { kind: "path", value: session } } }
        : { process_info: { foreground_processes: foreground } }) as never);
      const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ foreground_processes: foreground } as never);
      const memory = { argv: [launcher, script], environ: [`HOME=${root}`, "PATH=/usr/bin:/bin"], executable };
      const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(memory);
      const read = spyOn(herdr, "paneRead").mockResolvedValue({ text: " π > ⟳ Opus 5.5 > 🗑 project ▶─2%────┃─1M─\n╰─" } as never);
      const spawn = spyOn(Bun, "spawn");
      restores.push(() => spawn.mockRestore(), () => read.mockRestore(), () => probe.mockRestore(), () => info.mockRestore(), () => rpc.mockRestore(), () => snapshot.mockRestore());
      const answer = await paneConversation(pane.pane_id);
      expect(existsSync(marker)).toBe(false);
      expect(info).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(answer).toMatchObject({ source: "omp-transcript", turns: [], metadata: { model: null, reasoning_effort: null } });
      expect(answer.screen).toBeUndefined();
    } finally {
      for (const restore of restores) restore();
      child.kill();
      await child.exited;
      if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
      forgetTranscriptState();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
