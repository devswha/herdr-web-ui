import { describe, expect, test } from "bun:test";
import { FakePtySession, onPtyEvent, queueInitialOutput, type PtySessionOptions } from "./fake-pty-session";

function createSession(onData: (data: string) => void = () => {}, onExit: (code: number | null) => void = () => {}): FakePtySession {
  const options: PtySessionOptions = {
    command: "ignored",
    args: [],
    cols: 80,
    rows: 24,
    onData,
    onExit,
  };
  return new FakePtySession(options);
}

describe("FakePtySession", () => {
  test("delivers queued Unicode seed synchronously and consumes it once", () => {
    const received: string[] = [];
    queueInitialOutput("한글", "🙂");
    createSession((data) => received.push(data));
    const next: string[] = [];
    createSession((data) => next.push(data));
    expect(received).toEqual(["한글", "🙂"]);
    expect(next).toEqual([]);
  });

  test("emits live data and queued resume output only on resume", () => {
    const received: string[] = [];
    const session = createSession((data) => received.push(data));
    session.emitData("live");
    session.queueOutputOnResume("sentinel");
    expect(received).toEqual(["live"]);
    session.resume();
    expect(received).toEqual(["live"]);
    session.pause();
    session.resume();
    expect(received).toEqual(["live", "sentinel"]);
  });

  test("delivers events to a listener armed before any instance exists", () => {
    const events: string[] = [];
    const unsubscribe = onPtyEvent((event) => events.push(event.type));
    const session = createSession();
    session.pause();
    session.resume();
    session.kill();
    unsubscribe();
    expect(events).toEqual(["pause", "resume", "kill", "exit"]);
  });

  test("records writes and resizes deterministically", () => {
    const session = createSession();
    session.write("input");
    session.resize(100, 40);
    expect(session.writes).toEqual(["input"]);
    expect(session.resizes).toEqual([{ cols: 100, rows: 40 }]);
  });

  test("kill is idempotent, invokes onExit once, and resolves exited", async () => {
    let exitCalls = 0;
    const session = createSession(() => {}, () => exitCalls++);
    session.kill();
    session.kill();
    await session.exited;
    expect(session.killCount).toBe(1);
    expect(exitCalls).toBe(1);
  });
});
