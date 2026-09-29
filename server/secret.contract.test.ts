import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { paneRead, paneSendText, workspaceClose, workspaceCreate } from "./herdr/client.ts";

it("secret frames validate prompts and authority, never queue, and type one no-echo line", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-secret-"));
  const resultFile = join(root, "result.json");
  // A no-echo stand-in: record only a digest and byte count, never the entered value.
  const script = join(root, "ask.cjs");
  writeFileSync(script, `
const { writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
process.stdin.setRawMode(true); process.stdin.resume();
let value = "";
process.stdout.write("\\x1b[2J\\x1b[HPassword:");
process.stdin.on("data", chunk => {
  value += chunk.toString();
  if (!value.includes("\\r")) return;
  writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ hash: createHash("sha256").update(value).digest("hex"), length: value.length }));
  value = ""; process.stdout.write("\\r\\nAccepted\\r\\nReady>");
});
`);
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  const seen: any[] = [];
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (!(await predicate())) { if (Date.now() > deadline) throw new Error("Secret contract deadline"); await Bun.sleep(25); }
  };
  try {
    const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-secret" });
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`);
    await until(async () => (await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trim() === "Password:");
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    expect(seen.find((frame) => frame.type === "snapshot").features).toContain("secret-input");
    const send = (frame: unknown) => socket!.send(JSON.stringify(frame));
    const secret = (id: number, extra = {}) => send({ type: "secret", id, pane_id: pane, prompt: "Password:", secret: "fixture-value", ...extra });
    const result = async (id: number) => {
      await until(() => seen.some((frame) => frame.type === "secret-result" && frame.id === id));
      return seen.find((frame) => frame.type === "secret-result" && frame.id === id);
    };
    secret(1);
    expect((await result(1)).code).toBe("not_attached");
    send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
    await until(() => seen.some((frame) => frame.type === "pty-data"));
    secret(2, { prompt: "Enter PIN:" });
    expect((await result(2)).code).toBe("prompt_changed");
    secret(3, { secret: "unsafe\ncommand" });
    expect((await result(3)).code).toBe("invalid_secret");
    send({ type: "role", mode: "observe" });
    secret(4);
    expect((await result(4)).code).toBe("read_only");
    expect(existsSync(resultFile)).toBe(false);
    send({ type: "role", mode: "interact" });
    // Authority can change while the screen check awaits herdr.
    secret(8); send({ type: "role", mode: "observe" });
    expect((await result(8)).code).toBe("read_only");
    expect(existsSync(resultFile)).toBe(false);
    send({ type: "role", mode: "interact" });
    // One prompt check is in flight: another secret must be refused, never held.
    secret(5); secret(6);
    expect((await result(6)).code).toBe("pane_busy");
    expect((await result(5)).ok).toBe(true);
    await until(() => existsSync(resultFile));
    const expected = "fixture-value\r";
    expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({ hash: createHash("sha256").update(expected).digest("hex"), length: expected.length });
    secret(7);
    expect((await result(7)).code).toBe("prompt_changed");
    expect(JSON.stringify(seen)).not.toContain("fixture-value");
    expect((await paneRead({ paneId: pane, source: "visible", format: "text" })).text).not.toContain("fixture-value");
  } finally {
    socket?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
