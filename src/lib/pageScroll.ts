/** A natív sorok és a chat pixelei ugyanannyi átfedő sort hagynak láthatóan. */
export function pageScrollDistance(viewport: number, lineHeight: number, overlapRows: number): number {
  return Math.max(1, viewport - lineHeight * overlapRows);
}
