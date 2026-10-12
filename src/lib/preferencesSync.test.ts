import { describe, expect, it } from "bun:test";
import { DEFAULT_SETTINGS, sharedSettings } from "./settings.ts";
import { preferencesChange, withShared } from "./preferencesSync.ts";

describe("preferences sync", () => {
  it("sends only the shared settings that changed, and the pins only when they did", () => {
    const base = { settings: sharedSettings(DEFAULT_SETTINGS), pins: ["local:w1:p1"] };
    expect(preferencesChange(base, { ...DEFAULT_SETTINGS, terminalFontSize: 20, alertsOn: false }, ["local:w1:p1"])).toBeNull();
    expect(preferencesChange(base, { ...DEFAULT_SETTINGS, theme: "light", terminalFontSize: 20 }, ["local:w1:p1"])).toEqual({ settings: { theme: "light" } });
    expect(preferencesChange(base, DEFAULT_SETTINGS, [])).toEqual({ settings: {}, pins: [] });
    expect(preferencesChange(base, { ...DEFAULT_SETTINGS, usageOrder: ["claude"] }, ["local:w1:p1"])).toEqual({ settings: { usageOrder: ["claude"] } });
  });

  it("takes only the shared part, and an invalid value as the setting's default would be read", () => {
    const mine = { ...DEFAULT_SETTINGS, theme: "light" as const, terminalFontSize: 20, alertsOn: false };
    const taken = withShared(mine, { settings: { theme: "dark", palette: "forest" } });
    expect([taken.theme, taken.palette, taken.terminalFontSize, taken.alertsOn]).toEqual(["dark", "forest", 20, false]);
    const odd = withShared(DEFAULT_SETTINGS, { settings: { theme: "purple", agentCards: "yes" } });
    expect([odd.theme, odd.agentCards]).toEqual([DEFAULT_SETTINGS.theme, DEFAULT_SETTINGS.agentCards]);
  });
});
