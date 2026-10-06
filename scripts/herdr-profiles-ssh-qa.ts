/** Docker-backed SSH lifecycle test. Build scripts/fixtures/herdr-ssh first.
 * HERDR_SSH_QA_BUNDLE must point to a verified official bundle for the Docker host platform.
 * Uses a temporary container/account, real SSH, real Herdr and no API mocks.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../server/index.ts";
import { parseHerdrProfiles } from "../server/herdr-profiles.ts";
import { REMOTE_BUNDLE_VERSION, type Machine, type SetupJob } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, WorkspaceCreated } from "../shared/protocol.ts";

const archive = resolve(process.env.HERDR_SSH_QA_BUNDLE ?? "");
assert.ok(process.env.HERDR_SSH_QA_BUNDLE && existsSync(archive), "Set HERDR_SSH_QA_BUNDLE to the verified bundle archive");
const root = mkdtempSync(join(tmpdir(), "herdr-profiles-ssh-"));
const container = `herdr-profiles-qa-${process.pid}`;
const state = join(root, "state");
const oldManifest = process.env.HERDR_WEB_BUNDLE_MANIFEST, oldSocket = process.env.HERDR_SOCKET;
process.env.HERDR_SOCKET = join(root, "local-offline.sock");
let server: ReturnType<typeof createServer> | undefined;
let rows: ReturnType<typeof parseHerdrProfiles> = [];
const sockets: WebSocket[] = [];
function command(args: string[]) {
  const r = Bun.spawnSync(args, { timeout: 180_000 });
  assert.equal(r.exitCode, 0, `${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
function remote(script: string) { return command(["docker", "exec", "-u", "fixture", "-e", "HOME=/home/fixture", container, "sh", "-c", script]); }
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout; let value: T;
  do { value = await read(); if (done(value)) return value; await Bun.sleep(100); } while (Date.now() < deadline);
  throw new Error(`Timed out ${label}: ${JSON.stringify(value!)}`);
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { "x-herdr-machine": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json() as Promise<T>;
}
const machines = async () => (await api<{ machines: Machine[] }>("/api/machines")).machines;
const start = () => createServer({ port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, stateDir: state, herdrProfiles: async () => rows });
async function connect(machine: Machine) {
  let job = await api<SetupJob>("/api/machines/setup", "POST", { ...machine.target, machine_id: machine.id });
  let approved = false;
  const deadline = Date.now() + 180_000;
  while (!["connected", "failed", "cancelled"].includes(job.phase)) {
    assert.ok(Date.now() < deadline, `setup deadline: ${job.phase}`);
    if (job.challenge) job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "answer", challenge_id: job.challenge.id, answer: job.challenge.kind === "host_key" ? "yes" : "herdr-test-only" });
    else if (job.phase === "approval") {
      assert.ok(!job.installations.some((s) => s.startsWith("Bundled herdr")), "existing Herdr must be reused");
      approved = true; job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "approve" });
    } else { await Bun.sleep(100); job = await api<SetupJob>(`/api/machines/setup/${job.id}`); }
  }
  assert.equal(job.phase, "connected", job.error ?? ""); assert.ok(approved);
  return job;
}
try {
  command(["docker", "run", "-d", "--name", container, "-p", "127.0.0.1::22", "herdr-profile-ssh-qa"]);
  const port = Number(command(["docker", "port", container, "22/tcp"]).split(":").at(-1));
  command(["docker", "cp", archive, `${container}:/tmp/bundle.tgz`]);
  // The account already has Herdr; the web runtime is deliberately NOT installed yet.
  command(["docker", "exec", container, "sh", "-c", "mkdir -p /home/fixture/.local/bin; tar xzf /tmp/bundle.tgz -C /tmp ./bin/herdr; cp /tmp/bin/herdr /home/fixture/.local/bin/herdr; chown -R fixture:fixture /home/fixture/.local"]);
  remote("nohup /home/fixture/.local/bin/herdr server >/tmp/herdr-default.log 2>&1 </dev/null &");
  await until(async () => remote("/home/fixture/.local/bin/herdr status server"), (s) => s.includes("status: running"), "existing default Herdr");
  const groundTruth = JSON.parse(remote('/home/fixture/.local/bin/herdr workspace create --label existing-default --cwd /home/fixture'));
  assert.ok(groundTruth);
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const filename = "bundle.tgz";
  command(["ln", "-s", archive, join(root, filename)]);
  const platform = remote("uname -m") === "x86_64" ? "linux-x64" : "linux-arm64";
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: filename, sha256 } } }));
  process.env.HERDR_WEB_BUNDLE_MANIFEST = manifest;
  rows = parseHerdrProfiles(JSON.stringify([{ id: "default-fixture", label: "Existing default", target: `ssh://fixture@127.0.0.1:${port}`, session: "default", enabled: true }]));
  assert.equal(rows[0]!.target!.session, undefined);
  server = start();
  const discovered = await until(machines, (list) => list.some((m) => m.herdr_profile_id === "default-fixture"), "discovery");
  const machine = discovered.find((m) => m.herdr_profile_id)!;
  await connect(machine);
  assert.ok(existsSync(join(state, "ssh", machine.id)), "dedicated key saved");
  const path = `/api/machines/${machine.id}`;
  const snapshot = (await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot;
  assert.ok(snapshot.workspaces.some((w) => w.label === "existing-default"), "inherited default is the existing server");
  assert.equal(remote("test ! -e /home/fixture/.config/herdr/sessions/default/herdr.sock && echo correct"), "correct");
  console.log("PASS discovery, fingerprint/password approval, bundle install, existing Herdr reuse and default session identity");
  const created = await api<WorkspaceCreated>(path + "/workspace/create", "POST", { cwd: "/home/fixture", label: "herdr-web-ui-test-ssh-profile" });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?machine_id=${machine.id}`); sockets.push(ws);
  const frames: ServerMessage[] = [];
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)) as ServerMessage; frames.push(m); if (m.type === "pty-data" && m.flow) ws.send(JSON.stringify({ type: "pty-ack", pane_id: m.pane_id, stream_id: m.flow.stream_id, offset: m.flow.offset })); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket failed")); });
  ws.send(JSON.stringify({ type: "role", mode: "interact" }));
  ws.send(JSON.stringify({ type: "attach", pane_id: created.pane_id, cols: 80, rows: 24, flow_control: "ack" }));
  await until(async () => frames, (f) => f.some((m) => m.type === "pty-data"), "terminal paint");
  ws.send(JSON.stringify({ type: "resize", pane_id: created.pane_id, cols: 90, rows: 28 }));
  ws.send(JSON.stringify({ type: "input", pane_id: created.pane_id, text: "printf 'profile-input-ok\\n'\r" }));
  await until(async () => api<{ read: { text: string } }>(path + `/pane/read?pane_id=${encodeURIComponent(created.pane_id)}&source=recent&format=text`), (v) => v.read.text.includes("profile-input-ok"), "terminal input");
  ws.close();
  console.log("PASS real remote terminal attach, resize and input");
  server.stop(); server = start();
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "manager restart");
  const descriptors = JSON.parse(remote("cat /home/fixture/.config/herdr-web-ui/bridges/*.json"));
  remote(`kill -TERM ${Number(descriptors.pid)}`);
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state !== "connected"), "bridge stopped");
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "approved bridge auto-restart");
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === created.pane_id));
  console.log("PASS manager restart and approved bridge restart preserve existing panes");
  rows = [{ ...rows[0]!, enabled: false }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && !m.enabled && m.state === "disconnected"), "source disable");
  rows = [{ ...rows[0]!, enabled: true }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "source re-enable");
  rows = [{ ...rows[0]!, target: { ...rows[0]!.target!, session: "named-fixture" } }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.target?.session === "named-fixture"), "retarget");
  assert.ok(!existsSync(join(state, "ssh", machine.id)), "retarget clears old key");
  await connect((await machines()).find((m) => m.id === machine.id)!);
  const named = (await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot;
  assert.ok(!named.workspaces.some((w) => w.label === "existing-default"), "named session remains distinct");
  rows = [];
  await until(machines, (ms) => !ms.some((m) => m.id === machine.id), "source removal");
  assert.ok(!existsSync(join(state, "ssh", machine.id)), "removal clears generated key");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "herdr-profile-state.json"), "utf8")), []);
  assert.ok(remote("/home/fixture/.local/bin/herdr status server").includes("status: running"));
  console.log("PASS disable/re-enable, named-session retarget, new approval and removal cleanup; Herdr stays running");
} finally {
  for (const ws of sockets) ws.close(); server?.stop();
  Bun.spawnSync(["docker", "rm", "-f", container]);
  for (const [key, value] of [["HERDR_WEB_BUNDLE_MANIFEST", oldManifest], ["HERDR_SOCKET", oldSocket]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  rmSync(root, { recursive: true, force: true });
}
