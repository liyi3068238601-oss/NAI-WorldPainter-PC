/** Maps a pointer position in a comparison viewport to the revealed after percentage. */
export function mobileInpaintComparePercent(clientX: number, left: number, width: number) {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return null;
  return Math.max(0, Math.min(100, ((clientX - left) / width) * 100));
}

/** The phone comparison reveals the generated result from the left edge. */
export function mobileInpaintAfterClip(percent: number) {
  const clamped = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 50;
  return `inset(0 ${100 - clamped}% 0 0)`;
}
