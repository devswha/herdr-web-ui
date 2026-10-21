import { describe, expect, it } from "bun:test";
import { forgetSessionHistoryProbe, sharedSessionHistoryProbe } from "./useSessionHistoryOffered.ts";

describe("sharedSessionHistoryProbe", () => {
  it("asks a PC once for every pane and menu that wants the answer", async () => {
    let asked = 0;
    const ask = async () => { asked++; return true; };
    const answers = await Promise.all([1, 2, 3].map(() => sharedSessionHistoryProbe("pc-shared", ask)));
    expect(answers).toEqual([true, true, true]);
    expect(await sharedSessionHistoryProbe("pc-shared", ask)).toBe(true);
    expect(asked).toBe(1);
    forgetSessionHistoryProbe("pc-shared");
  });
  it("asks again once the PC went away, and after a probe that failed", async () => {
    let asked = 0;
    const missing = async () => { asked++; return false; };
    expect(await sharedSessionHistoryProbe("pc-again", missing)).toBe(false);
    forgetSessionHistoryProbe("pc-again");
    expect(await sharedSessionHistoryProbe("pc-again", missing)).toBe(false);
    expect(asked).toBe(2);
    forgetSessionHistoryProbe("pc-again");
    const failing = async (): Promise<boolean> => { asked++; throw new Error("the PC did not answer"); };
    await expect(sharedSessionHistoryProbe("pc-failing", failing)).rejects.toThrow("the PC did not answer");
    expect(await sharedSessionHistoryProbe("pc-failing", missing)).toBe(false);
    expect(asked).toBe(4);
    forgetSessionHistoryProbe("pc-failing");
  });
});
