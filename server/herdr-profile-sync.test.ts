import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineManager } from "./machines.ts";
import type { HerdrMachineProfile, Machine } from "../shared/machines.ts";
import type { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";
import { HerdrProfileState } from "./herdr-profile-state.ts";
import { SshConnection } from "./ssh.ts";

const profile: HerdrMachineProfile = { id: "source-a", label: "Build machine", enabled: true, target: { destination: "BuildBox", port: 2222, session: "agents" } };
type Runtime = { machine: Machine; generation: number; terminals: Set<() => void> };
type Internals = { profileState: HerdrProfileState; mayManageBridge(runtime: Runtime): boolean; reconnect(runtime: Runtime): Promise<void>; machines: Map<string, Runtime>; persist(): void; prepare(runtime: unknown): Promise<void> };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-profile-sync-"));
  const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("isolated local offline"); });
  const internals = manager as unknown as Internals;
  const reconnect = spyOn(internals, "reconnect").mockImplementation(async () => {});
  cleanups.push(() => { manager.stop(); reconnect.mockRestore(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, internals, reconnect, dir };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(5); }
}

describe("automatic herdr machine inheritance", () => {
  it("discovers profiles, keeps stable identities and named sessions, and only reconnects changed targets", () => {
    const { manager, reconnect } = fixture();
    manager.syncHerdrProfiles([profile]);
    const first = manager.list()[1]!;
    expect(first).toMatchObject({ herdr_profile_id: "source-a", name: "Build machine", target: profile.target, enabled: true });
    expect(reconnect).toHaveBeenCalledTimes(1);
    manager.syncHerdrProfiles([profile]);
    manager.syncHerdrProfiles([{ ...profile, label: "Renamed" }]);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(manager.list()[1]).toMatchObject({ id: first.id, name: "Renamed" });
    manager.syncHerdrProfiles([{ ...profile, target: { destination: "BuildBox", session: "other" } }]);
    expect(reconnect).toHaveBeenCalledTimes(2);
    const next = fixture(); next.manager.syncHerdrProfiles([profile]);
    expect(next.manager.list()[1]?.id).toBe(first.id);
  });
  it("follows disable, enable and removal, releasing browser attachments", () => {
    const { manager, internals, reconnect } = fixture();
    manager.syncHerdrProfiles([profile]);
    let closed = 0;
    const runtime = internals.machines.get(manager.list()[1]!.id)!;
    runtime.terminals.add(() => closed++);
    manager.syncHerdrProfiles([{ ...profile, enabled: false }]);
    expect(closed).toBe(1);
    expect(runtime.machine).toMatchObject({ enabled: false, state: "disconnected", action_required: null });
    expect(reconnect).toHaveBeenCalledTimes(1);
    manager.syncHerdrProfiles([profile]);
    expect(reconnect).toHaveBeenCalledTimes(2);
    const generation = runtime.generation;
    manager.syncHerdrProfiles([]);
    expect(manager.list().map((m) => m.id)).toEqual(["local"]);
    expect(runtime.generation).toBeGreaterThan(generation);
    expect(runtime.machine.enabled).toBe(false);
  });
  it("never connects unsupported or disabled profiles; clears the old snapshot when a target changes", () => {
    const { manager, reconnect } = fixture();
    manager.syncHerdrProfiles([{ ...profile, enabled: false }, { ...profile, id: "invalid", target: null }]);
    expect(manager.list()).toHaveLength(3);
    expect(reconnect).not.toHaveBeenCalled();
    expect(manager.list()[2]?.error).toContain("unsupported");
    manager.syncHerdrProfiles([profile]);
    manager.list()[1]!.snapshot = { panes: [] } as any;
    manager.syncHerdrProfiles([{ ...profile, target: { destination: "new-host", session: "other" } }]);
    expect(manager.list()[1]?.snapshot).toBeNull();
  });
  it("keeps manual registrations and suppresses exact duplicates, but distinguishes sessions", () => {
    const { manager, internals } = fixture();
    internals.machines.set("manual", { machine: { id: "manual", name: "Manual", kind: "ssh", target: profile.target!, enabled: false, state: "disconnected", error: null, snapshot: null }, generation: 0, terminals: new Set() });
    manager.syncHerdrProfiles([profile, { ...profile, id: "other-session", target: { ...profile.target!, session: "different" } }]);
    expect(manager.list()).toHaveLength(3);
    expect(manager.list()[1]).toMatchObject({ id: "manual", name: "Manual", enabled: false });
    manager.syncHerdrProfiles([]);
    expect(manager.list().map((m) => m.id)).toEqual(["local", "manual"]);
  });
  it("derives rows rather than persisting a second catalog and refuses conflicting web mutations", () => {
    const { manager, internals, dir } = fixture();
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    internals.persist();
    expect(JSON.parse(readFileSync(join(dir, "machines.json"), "utf8"))).toEqual([]);
    expect(() => manager.patch(machine.id, { name: "Other" })).toThrow("in herdr");
    expect(() => manager.patch(machine.id, { enabled: false })).toThrow("in herdr");
    expect(() => manager.remove(machine.id)).toThrow("in herdr");
    expect(() => manager.setup({ machine_id: machine.id, destination: "changed" })).toThrow("managed by herdr");
    manager.syncHerdrProfiles([{ ...profile, enabled: false }]);
    expect(() => manager.setup({ machine_id: machine.id, ...profile.target! })).toThrow("managed by herdr");
  });
  it("polls serially, preserves the last good roster on failure and ignores a late read after stop", async () => {
    const { manager } = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {}); cleanups.push(() => log.mockRestore());
    let calls = 0, active = 0, maxActive = 0;
    let release!: (rows: HerdrMachineProfile[]) => void;
    manager.watchHerdrProfiles(async () => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return [profile];
        if (calls === 2) throw new Error("broken catalog");
        return await new Promise<HerdrMachineProfile[]>((resolve) => { release = resolve; });
      } finally { active--; }
    }, 5);
    await until(() => calls === 3);
    expect(manager.list()[1]?.herdr_profile_id).toBe(profile.id);
    expect(maxActive).toBe(1);
    manager.stop(); release([{ ...profile, label: "late" }]);
    await until(() => active === 0);
    expect(manager.list()[1]?.name).toBe("Build machine");
    expect(calls).toBe(3);
  });
  it("cancels a real pending authentication job when its source changes, disables or disappears", async () => {
    const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) {
      if (!challenge) throw new Error("test requires interactive setup");
      await challenge("Fixture passphrase", false);
    });
    cleanups.push(() => start.mockRestore());
    for (const next of [[], [{ ...profile, enabled: false }], [{ ...profile, target: { destination: "new-host", session: "other" } }]]) {
      const { manager } = fixture();
      manager.syncHerdrProfiles([profile]);
      const id = manager.list()[1]!.id;
      const job = manager.setup({ ...profile.target!, machine_id: id });
      await until(() => manager.job(job.id)?.phase === "authentication");
      manager.syncHerdrProfiles(next);
      expect(manager.job(job.id)?.phase).toBe("cancelled");
      expect(manager.job(job.id)?.challenge).toBeNull();
      expect(() => manager.action(job.id, { action: "approve" })).toThrow("already changed");
      await Bun.sleep(0);
      if (!next.length) expect(manager.list().map((m) => m.id)).toEqual(["local"]);
      else expect(manager.list()[1]?.target).toEqual(next[0]!.target!);
    }
  });
  it("retains web approval and snapshots across a manager restart, but revokes them and keys on retarget/removal", () => {
    const { manager, internals, dir } = fixture();
    manager.syncHerdrProfiles([profile]);
    const machine = manager.list()[1]!;
    const runtime = internals.machines.get(machine.id)!;
    expect(internals.mayManageBridge(runtime)).toBe(false);
    internals.profileState.approve(profile.id, profile.target!);
    machine.snapshot = { panes: [{ pane_id: "cached" }] } as any;
    internals.persist(); manager.stop();
    const restored = new MachineManager(dir, {} as PushService, {} as CompletionTracker, async () => { throw new Error("offline"); });
    const restoredInternals = restored as unknown as Internals;
    const reconnect = spyOn(restoredInternals, "reconnect").mockImplementation(async () => {});
    cleanups.push(() => { restored.stop(); reconnect.mockRestore(); });
    restored.syncHerdrProfiles([profile]);
    expect(restored.list()[1]?.snapshot?.panes[0]?.pane_id).toBe("cached");
    expect(restoredInternals.mayManageBridge(restoredInternals.machines.get(machine.id)!)).toBe(true);
    const key = join(dir, "ssh", machine.id);
    mkdirSync(join(dir, "ssh"), { recursive: true }); writeFileSync(key, "fixture key");
    restored.syncHerdrProfiles([{ ...profile, target: { destination: "replacement" } }]);
    expect(restoredInternals.mayManageBridge(restoredInternals.machines.get(machine.id)!)).toBe(false);
    expect(restored.list()[1]?.snapshot).toBeNull();
    expect(existsSync(key)).toBe(false);
    writeFileSync(key, "fixture key"); writeFileSync(key + ".pub", "fixture public key");
    restored.syncHerdrProfiles([]);
    expect(existsSync(key)).toBe(false); expect(existsSync(key + ".pub")).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "herdr-profile-state.json"), "utf8"))).toEqual([]);
  });
  it("rejects key overrides and keeps an unchanged profile's interactive setup alive across polls", async () => {
    const start = spyOn(SshConnection.prototype, "start").mockImplementation(async function (challenge) { await challenge!("Fixture passphrase", false); });
    cleanups.push(() => start.mockRestore());
    const { manager } = fixture(); manager.syncHerdrProfiles([profile]);
    const machine_id = manager.list()[1]!.id;
    expect(() => manager.setup({ ...profile.target!, machine_id, identity_file: "/tmp/other-key" })).toThrow("managed by herdr");
    const job = manager.setup({ machine_id, session: "agents", destination: "BuildBox", port: 2222 });
    await until(() => job.phase === "authentication");
    manager.syncHerdrProfiles([profile]); manager.syncHerdrProfiles([{ ...profile, label: "Renamed" }]);
    expect(job.phase).toBe("authentication");
    manager.action(job.id, { action: "cancel" });
  });
  it("backs off repeated discovery errors and logs again only after recovery", async () => {
    const { manager } = fixture();
    const log = spyOn(console, "error").mockImplementation(() => {}); cleanups.push(() => log.mockRestore());
    const times: number[] = [];
    manager.watchHerdrProfiles(async () => { times.push(Date.now()); if (times.length !== 4) throw new Error("unavailable"); return [profile]; }, 10);
    await until(() => times.length >= 5);
    manager.stop();
    expect(log).toHaveBeenCalledTimes(2);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(30);
    expect(times[3]! - times[2]!).toBeGreaterThanOrEqual(60);
    expect(manager.list()[1]?.herdr_profile_id).toBe(profile.id);
  });
  it("a discovered PC with a preinstalled runtime still requires approval before starting a missing bridge", async () => {
    const { internals } = fixture();
    const ssh = { run: async (script: string) => {
      if (script.includes("uname")) return "Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\nbundle-ready\n";
      if (script.startsWith("socket=")) return "/home/fixture/.config/herdr/sessions/agents/herdr.sock";
      if (script.includes("--version")) return "herdr 0.9.3";
      throw new Error("Unexpected remote mutation: " + script);
    } } as unknown as SshConnection;
    await expect(internals.prepare({ machine: { herdr_profile_id: profile.id, target: profile.target }, ssh, generation: 0 })).rejects.toMatchObject({ action: "setup" });
  });
});
