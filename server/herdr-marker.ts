/**
 * On Windows herdr.sock is a marker file `pid:start` that a killed daemon leaves behind.
 * Its pid alone does not say whether the daemon is there: Windows hands a dead process's
 * pid to the next one, so after a reboot some other program can hold it. What runs under
 * that pid decides.
 */
export function markerPid(marker: string): number | null {
  const pid = Number(marker.split(":")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The image name in `tasklist /FI "PID eq N" /FO CSV /NH`; null when it lists no process (its "no tasks" line is localized, and never quoted). */
export function tasklistImage(csv: string): string | null {
  return /^"([^"]+)"/m.exec(csv)?.[1] ?? null;
}

/**
 * A marker nobody stands behind: its pid is gone (`imageOf` answers null) or belongs to a
 * program that is not herdr. A marker that cannot be read is not called stale: replacing a
 * daemon needs proof that it is gone.
 */
export function staleMarker(marker: string, imageOf: (pid: number) => string | null): boolean {
  const pid = markerPid(marker);
  if (pid === null) return false;
  const image = imageOf(pid);
  return image === null || !/herdr/i.test(image);
}
