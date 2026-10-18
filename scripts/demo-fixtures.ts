/**
 * Captures what the browser demo (scripts/demo/transport.ts) serves in place of a server: the machine
 * roster with herdr's real snapshot shapes, the agent kinds, one pane's slash commands, and the
 * shell pane's terminal output for `git log` and `bun test`, on an 80×24 grid so the recording
 * replays on a phone. Everything comes from an isolated, fictional session
 * (scripts/demo/stage.ts), never from the herdr you work in, and the real hostname and
 * login are replaced before anything is written to scripts/demo/fixtures/.
 *
 *   bun scripts/demo-fixtures.ts
 */
import { hostname, userInfo } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stage } from "./demo/stage.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const OUT = join(import.meta.dir, "./demo/fixtures");
const REAL_HOST = hostname();
const REAL_USER = userInfo().username;
const demo = await stage();
/** neither the machine's name nor the user's login belong in a public fixture */
const scrub = (text: string) => text.split(REAL_HOST).join("workstation").split(REAL_USER).join("demo");
const save = (name: string, body: unknown) => writeFileSync(join(OUT, name), JSON.stringify(body, null, 2) + "\n");
const get = async (path: string): Promise<unknown> => JSON.parse(scrub(await (await fetch(demo.base + path)).text()));

try {
  mkdirSync(OUT, { recursive: true });
  const machines = [{ id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null, snapshot: (await get("/api/session") as { snapshot: unknown }).snapshot }];
  save("machines.json", { machines });
  save("agents.json", await get("/api/agents"));
  save("commands.json", await get(`/api/pane/commands?pane_id=${encodeURIComponent(demo.pane("api").pane)}`));
  save("panes.json", Object.fromEntries(demo.panes.map((p) => [p.key, p.pane])));

  // the shell pane's terminal fixture: real git history, real tests
  const shell = demo.pane("shell").pane;
  const frames: Array<{ at: number; data: string }> = [];
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${demo.base.replace(/^http/, "ws")}/ws`);
    const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
    const type = (text: string, after: number) => setTimeout(() => send({ type: "input", pane_id: shell, text }), after);
    socket.addEventListener("open", () => {
      send({ type: "role", mode: "interact" });
      send({ type: "attach", pane_id: shell, cols: 80, rows: 24 });
      type("git log --oneline --graph --decorate | head -8\n", 700);
      type("bun test\n", 1900);
      setTimeout(() => { socket.close(); resolve(); }, 5200);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === "pty-data" && message.pane_id === shell) frames.push({ at: Date.now() - started, data: scrub(message.data) });
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed")));
  });
  save("terminal.json", { pane: "shell", cols: 80, rows: 24, frames });
  console.log(`${machines.length} machine(s), ${frames.length} terminal frames -> ${OUT}`);
} finally {
  await demo.teardown();
}
process.exit(0);
