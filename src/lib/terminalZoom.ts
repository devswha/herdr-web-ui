/** Browser zoom chords, handled only inside the terminal; all other keys remain the pty's. */
export function terminalZoomKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">): -1 | 0 | 1 | null {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey === event.metaKey) return null;
  if (event.key === "+" || event.key === "=") return 1;
  if (event.shiftKey) return null; // Ctrl+Shift+- is the terminal's Ctrl+_ (undo).
  if (event.key === "-") return -1;
  if (event.key === "0") return 0;
  return null;
}

/** Accumulate smooth pinch deltas instead of changing one font size per tiny wheel event. */
export function terminalZoomWheel(remainder: number, deltaY: number, deltaMode: number): { remainder: number; steps: number } {
  const delta = deltaY * (deltaMode === 1 ? 40 : deltaMode === 2 ? 100 : 1);
  const total = (Math.sign(remainder) === Math.sign(delta) ? remainder : 0) + delta;
  const steps = Math.trunc(total / 100);
  return { remainder: total - steps * 100, steps: steps === 0 ? 0 : -steps };
}
