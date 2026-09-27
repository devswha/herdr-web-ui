import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { isOmoProcess, omoTranscriptForPane } from "./omo.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-omo-binding-"));
const workspaces: string[] = [];
const script = join(root, "omo");
writeFileSync(script, "setInterval(() => {}, 1000);\n");
const dir = join(root, ".omo", "agent", "sessions", `-${root.replaceAll("/", "-")}--`);
mkdirSync(dir, { recursive: true });
afterAll(async () => {
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
});

async function pane(id?: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-omo-binding" });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${script}${id ? ` --session-id ${id}` : ""}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    if (info.process_info?.foreground_processes?.some((process) => isOmoProcess(process.argv ?? []))) return paneId;
    await Bun.sleep(50);
  }
  throw new Error("test omo process did not start");
}
const read = async (paneId: string) => omoTranscriptForPane(paneId, root, (await sessionSnapshot()).panes, root);
const session = (id: string, timestamp = new Date().toISOString()) => {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd: root, timestamp }) + "\n");
  return path;
};

it("uses live process evidence and stops cwd inference as soon as a second omo shares it", async () => {
  const first = await pane();
  const fresh = session("fresh-session");
  expect(await read(first)).toBe(fresh);
  const resumed = session("resumed-session", "2020-01-01T00:00:00Z");
  const second = await pane("resumed-session");
  expect(await read(first)).toBeNull();
  expect(await read(second)).toBe(resumed);
  const duplicate = await pane("resumed-session");
  expect(await read(second)).toBeNull();
  expect(await read(duplicate)).toBeNull();
});

it("ignores the background task logs omo holds open outside its session store", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "herdr-omo-task-log-"));
  const store = join(cwd, ".omo", "agent", "sessions", `-${cwd.replaceAll("/", "-")}--`);
  const logs = join(cwd, ".omo", "senpi-task", "logs");
  mkdirSync(store, { recursive: true });
  mkdirSync(logs, { recursive: true });
  // a stand-in omo that holds a task log open, as omo does while a background task runs
  const holder = join(cwd, "omo");
  writeFileSync(holder, "require('node:fs').openSync(process.argv[2], 'a');\nsetInterval(() => {}, 1000);\n");
  const created = await workspaceCreate({ cwd, label: "herdr-web-ui-test-omo-task-log" });
  try {
    const paneId = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${process.execPath} ${holder} ${join(logs, "st_task.jsonl")}\n` });
    let held = false;
    for (let attempt = 0; attempt < 100 && !held; attempt++) {
      const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
      const omo = info.process_info?.foreground_processes?.find((process) => isOmoProcess(process.argv ?? []));
      if (omo) held = readdirSync(`/proc/${omo.pid}/fd`).some((fd) => { try { return readlinkSync(`/proc/${omo.pid}/fd/${fd}`).endsWith("st_task.jsonl"); } catch { return false; } });
      if (!held) await Bun.sleep(50);
    }
    expect(held).toBe(true);
    const path = join(store, "task-session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", id: "task-session", cwd, timestamp: new Date().toISOString() }) + "\n");
    expect(await omoTranscriptForPane(paneId, cwd, (await sessionSnapshot()).panes, cwd)).toBe(realpathSync(path));
  } finally {
    await workspaceClose(created.workspace.workspace_id);
    rmSync(cwd, { recursive: true, force: true });
  }
});
