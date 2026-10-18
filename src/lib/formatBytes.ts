/** Human-readable file sizes, using the largest useful unit. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  // Below 10 MB, one decimal preserves useful size information.
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes < 10 ? Math.round(megabytes * 10) / 10 : Math.round(megabytes)} MB`;
}
