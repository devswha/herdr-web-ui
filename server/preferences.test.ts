import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PINS } from "../shared/preferences.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-preferences-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const put = (store: PreferenceStore, body: string) => handlePreferencesRequest(new Request("http://x/api/preferences", { method: "PUT", body }), store);

describe("shared preferences", () => {
  it("starts empty, keeps only the shared names, counts each write, and survives a restart", async () => {
    const dir = root();
    const store = new PreferenceStore(dir);
    expect(await (await handlePreferencesRequest(new Request("http://x/api/preferences"), store)).json()).toEqual({ revision: 0, settings: {}, pins: [] });
    const heard: number[] = [];
    store.subscribe((preferences) => heard.push(preferences.revision));
    const first = await put(store, JSON.stringify({ settings: { theme: "light", terminalFontSize: 22, alertsOn: false, nonsense: 1 }, pins: ["local:w1:p1", "local:w1:p1", "pc:w2:p3"] }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revision: 1, settings: { theme: "light" }, pins: ["local:w1:p1", "pc:w2:p3"] });
    // a change lays its settings over what is held, and leaves the pins when it names none
    await put(store, JSON.stringify({ settings: { agentPins: true } }));
    expect(store.get()).toEqual({ revision: 2, settings: { theme: "light", agentPins: true }, pins: ["local:w1:p1", "pc:w2:p3"] });
    await put(store, JSON.stringify({ settings: { theme: "dark" }, pins: [] }));
    expect(heard).toEqual([1, 2, 3]);
    expect(JSON.parse(readFileSync(join(dir, "preferences.json"), "utf8"))).toMatchObject({ revision: 3, settings: { theme: "dark", agentPins: true }, pins: [] });
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 3, settings: { theme: "dark", agentPins: true }, pins: [] });
  });

  it("refuses what is not a preferences document", async () => {
    const store = new PreferenceStore(root());
    expect((await put(store, "{")).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: [], pins: [] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: [1] }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: {}, pins: Array.from({ length: MAX_PINS + 1 }, (_, i) => `pc:${i}`) }))).status).toBe(400);
    expect((await put(store, JSON.stringify({ settings: { quickReplies: ["x".repeat(70_000)] }, pins: [] }))).status).toBe(413);
    expect((await handlePreferencesRequest(new Request("http://x/api/preferences", { method: "POST", body: "{}" }), store)).status).toBe(405);
    expect(store.get().revision).toBe(0);
  });

  it("starts empty over a damaged file", () => {
    const dir = root();
    writeFileSync(join(dir, "preferences.json"), "not json");
    expect(new PreferenceStore(dir).get()).toEqual({ revision: 0, settings: {}, pins: [] });
  });
});
