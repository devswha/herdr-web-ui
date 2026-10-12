import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SteeringReceipts } from "./steering-receipts.ts";

describe("steering receipts", () => {
  it("replays a delivered request across clients and restart without typing again", async () => {
    const root = mkdtempSync(join(tmpdir(), "steering-test-"));
    try {
      const key = crypto.randomUUID();
      const receipts = new SteeringReceipts(root);
      let sends = 0;
      const send = async (mark: () => void) => { mark(); sends++; return { ok: true as const }; };
      const first = receipts.run(key, "fingerprint", send);
      const second = receipts.run(key, "fingerprint", send);
      expect(await first).toEqual({ ok: true });
      expect(await second).toEqual({ ok: true });
      expect(await new SteeringReceipts(root).run(key, "fingerprint", send)).toEqual({ ok: true });
      expect(sends).toBe(1);
      expect(await receipts.run(key.toUpperCase(), "fingerprint", send)).toEqual({ ok: true });
      await expect(receipts.run(key, "different", send)).rejects.toThrow("another message");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("blocks a stale pane identity and a crash during the write before any retry can type", async () => {
    const root = mkdtempSync(join(tmpdir(), "steering-test-"));
    try {
      const receipts = new SteeringReceipts(root); const key = crypto.randomUUID();
      await receipts.run(key, "fp", async (_, bind) => { bind({ agent: "codex", terminalId: "old", session: null }); return { ok: false }; });
      let writes = 0;
      const reply = await receipts.run(key, "fp", async (writing, bind) => { bind({ agent: "codex", terminalId: "new", session: null }); writing(); writes++; return { ok: true }; });
      expect(reply).toMatchObject({ ok: false, code: "steering_refused" }); expect(writes).toBe(0);
      const crash = crypto.randomUUID(); let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const first = receipts.run(crash, "fp", async (writing) => { writing(); await waiting; return { ok: true }; });
      const deadline = Date.now() + 1000;
      while (!existsSync(join(root, "steering-receipts", crash + ".json")) || JSON.parse(readFileSync(join(root, "steering-receipts", crash + ".json"), "utf8")).state !== "sending") { if (Date.now() >= deadline) throw new Error("receipt did not reach sending"); await Bun.sleep(1); }
      expect(await new SteeringReceipts(root).run(crash, "fp", async () => { writes++; return { ok: true }; })).toMatchObject({ ok: false, code: "submit_changed" });
      release(); await first; expect(writes).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("retries a pre-write refusal, but never replays an uncertain write or interrupted receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "steering-test-"));
    try {
      const receipts = new SteeringReceipts(root);
      const key = crypto.randomUUID();
      expect(await receipts.run(key, "fp", async () => ({ ok: false, code: "agent_blocked", message: "Answer first" }))).toMatchObject({ ok: false });
      expect(await receipts.run(key, "fp", async (mark) => { mark(); return { ok: true }; })).toEqual({ ok: true });
      const uncertain = crypto.randomUUID();
      await receipts.run(uncertain, "fp", async (mark) => { mark(); throw new Error("lost RPC acknowledgement"); });
      let sends = 0;
      const reply = await new SteeringReceipts(root).run(uncertain, "fp", async () => { sends++; return { ok: true }; });
      expect(reply).toMatchObject({ ok: false, code: "submit_changed" });
      expect(sends).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
