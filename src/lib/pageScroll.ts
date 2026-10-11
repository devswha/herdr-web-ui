/** Native rows and chat pixels retain the requested overlap between pages. */
export function pageScrollDistance(viewport: number, lineHeight: number, overlapRows: number): number {
  return Math.max(1, viewport - lineHeight * overlapRows);
}
