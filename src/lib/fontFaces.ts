import { useSyncExternalStore } from "react";

/** What this needs of a FontFace: where its load stands, and the promise that settles with it. */
export interface WatchedFace {
  readonly status: string;
  readonly loaded: Promise<unknown>;
}

/**
 * The faces whose arrival is still to come and is not followed yet; each is marked followed.
 * A face not asked for yet ("unloaded": a unicode-range chunk no text has needed) counts: its
 * `loaded` promise waits without starting the download, and the FontFaceSet tells nobody when
 * such a face starts loading while another is still in flight.
 */
export function facesToFollow<Face extends WatchedFace>(faces: Iterable<Face>, followed: WeakSet<Face>): Face[] {
  const next: Face[] = [];
  for (const face of faces) {
    if (face.status === "loaded" || face.status === "error" || followed.has(face)) continue;
    followed.add(face);
    next.push(face);
  }
  return next;
}

/** Calls `arrived` once for each of those faces when it has loaded. Returns how many it took on. */
export function followFaces<Face extends WatchedFace>(faces: Iterable<Face>, followed: WeakSet<Face>, arrived: () => void): number {
  const next = facesToFollow(faces, followed);
  for (const face of next) face.loaded.then(arrived, () => undefined);
  return next.length;
}

let arrivals = 0;
let started = false;
const listeners = new Set<() => void>();
const followed = new WeakSet<FontFace>();

const arrived = (): void => {
  arrivals += 1;
  for (const listener of listeners) listener();
};

function start(): void {
  if (started) return;
  started = true;
  const fonts = typeof document === "undefined" ? undefined : document.fonts as FontFaceSet | undefined;
  if (!fonts || typeof fonts.addEventListener !== "function") return;
  const sweep = (): void => { followFaces(fonts, followed, arrived); };
  sweep();
  // a face declared later (a stylesheet that came after this) is taken on when the set next stirs
  fonts.addEventListener("loading", sweep);
  // the backstop: every pending load has settled
  fonts.addEventListener("loadingdone", () => { sweep(); arrived(); });
}

const subscribe = (listener: () => void): (() => void) => {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * A number that grows each time one of the page's faces arrives. The app's faces swap in after
 * the first paint (fonts/fonts.css, `font-display: swap`) and are not as wide as the fallback
 * they replace: text rewraps and no box, font-size or family string changes for it, so nothing
 * else measures again. Each face is followed by itself: the set's `loadingdone` waits for every
 * pending load, and one chunk stalled on a bad link would hold back the ones already drawn.
 */
export function useFacesArrived(): number {
  return useSyncExternalStore(subscribe, () => arrivals, () => 0);
}
