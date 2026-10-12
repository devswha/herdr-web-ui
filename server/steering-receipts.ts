import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PendingIdentity } from "./pending-input.ts";

type Reply = { ok: boolean; code?: string; message?: string };
interface Receipt { fingerprint: string; state: "held" | "sending" | "sent" | "uncertain"; identity?: PendingIdentity; reply?: Reply }
const uncertain = (): Reply => ({ ok: false, code: "submit_changed", message: "Delivery is uncertain. Check the terminal; this message will not be typed again." });

/** One durable receipt per explicit steering ID. Retain receipts across reconnects and bridge updates.
 * No text or credentials are stored, and nothing resumes automatically. A pre-write refusal may be
 * retried; once a write might have happened, only the receipt is replayed, never the input. */
export class SteeringReceipts {
  private readonly active = new Map<string, { fingerprint: string; result: Promise<Reply> }>();
  private readonly directory: string;
  constructor(stateDir: string) { this.directory = join(stateDir, "steering-receipts"); }

  async run(id: string, fingerprint: string, task: (writing: () => void, bind: (identity: PendingIdentity) => void) => Promise<Reply>): Promise<Reply> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid steering ID");
    id = id.toLowerCase();
    const previous = this.active.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("This steering ID belongs to another message");
      return previous.result;
    }
    // Reserve synchronously before task can yield; two clients join the same operation.
    const result = Promise.resolve().then(async () => {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, id.toLowerCase() + ".json");
      let receipt: Receipt = { fingerprint, state: "held" };
      if (existsSync(file)) {
        try { receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt; } catch { return uncertain(); }
        if (receipt.fingerprint !== fingerprint) throw new Error("This steering ID belongs to another message");
        if (receipt.state === "sent") return { ok: true };
        if (receipt.state !== "held") return uncertain();
      }
      const save = () => {
        const temporary = file + ".tmp";
        const fd = openSync(temporary, "w", 0o600);
        try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, file);
        if (process.platform !== "win32") {
          const dir = openSync(this.directory, "r");
          try { fsyncSync(dir); } finally { closeSync(dir); }
        }
      };
      // Failure to save refuses the request before typing.
      save();
      let writing = false;
      try {
        const reply = await task(() => { receipt.state = "sending"; save(); writing = true; }, (identity) => {
          if (receipt.identity && JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error("The pane's terminal or agent session changed; nothing was typed");
          receipt.identity = identity; save();
        });
        receipt.state = reply.ok ? "sent" : writing ? "uncertain" : "held";
        receipt.reply = writing && !reply.ok ? uncertain() : reply;
        save();
        return receipt.reply;
      } catch (error) {
        receipt.state = writing ? "uncertain" : "held";
        receipt.reply = writing ? uncertain() : { ok: false, code: "steering_refused", message: error instanceof Error ? error.message : "Steering was refused before typing" };
        try { save(); } catch { /* the durable sending marker remains conservative */ }
        return receipt.reply;
      }
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, { fingerprint, result });
    return result;
  }
}
