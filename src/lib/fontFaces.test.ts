import { describe, expect, test } from "bun:test";
import { facesToFollow, followFaces, type WatchedFace } from "./fontFaces.ts";

interface Fake extends WatchedFace { arrive: () => void; fail: () => void; status: string }

const face = (status: string): Fake => {
  let arrive = (): void => undefined;
  let fail = (): void => undefined;
  const loaded = new Promise<void>((resolve, reject) => { arrive = resolve; fail = () => reject(new Error("network")); });
  return { status, loaded, arrive, fail };
};
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("faces whose arrival is followed", () => {
  test("a face in flight and one no text has asked for yet are followed; a drawn or failed one is not", () => {
    const loading = face("loading");
    const unloaded = face("unloaded");
    expect(facesToFollow([face("loaded"), loading, unloaded, face("error")], new WeakSet())).toEqual([loading, unloaded]);
  });

  test("a face is followed once, however often the set is swept", () => {
    const followed = new WeakSet<Fake>();
    const first = face("loading");
    expect(facesToFollow([first], followed)).toEqual([first]);
    const later = face("unloaded");
    expect(facesToFollow([first, later], followed)).toEqual([later]);
    expect(facesToFollow([first, later], followed)).toEqual([]);
  });

  test("each face reports its own arrival while another is still in flight", async () => {
    const stalled = face("loading");
    const quick = face("loading");
    const late = face("unloaded");
    let arrivals = 0;
    expect(followFaces([stalled, quick, late], new WeakSet(), () => { arrivals += 1; })).toBe(3);
    quick.arrive();
    await settled();
    expect(arrivals).toBe(1);
    late.arrive();
    await settled();
    expect(arrivals).toBe(2);
  });

  test("a face that fails to load is not an arrival and is not an unhandled rejection", async () => {
    const lost = face("loading");
    let arrivals = 0;
    followFaces([lost], new WeakSet(), () => { arrivals += 1; });
    lost.fail();
    await settled();
    expect(arrivals).toBe(0);
  });
});
