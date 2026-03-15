/**
 * coord-utils.js — Video content coordinate utilities.
 * Uses object-fit:cover math to map between canvas pixels and normalized [0,1] content space.
 */

export function getContentBounds(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const cw = videoEl.clientWidth;
  const ch = videoEl.clientHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.max(cw / vw, ch / vh);
  const rw = vw * scale;
  const rh = vh * scale;
  return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
}

/** Same as getContentBounds but for object-fit:contain (scale-to-fit, letterbox/pillarbox). */
export function getContentBoundsContain(videoEl) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const cw = videoEl.clientWidth;
  const ch = videoEl.clientHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };
  const scale = Math.min(cw / vw, ch / vh);
  const rw = vw * scale;
  const rh = vh * scale;
  return { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
}

export function pixelToContent(canvasX, canvasY, bounds) {
  return {
    x: Math.min(1, Math.max(0, (canvasX - bounds.x) / bounds.w)),
    y: Math.min(1, Math.max(0, (canvasY - bounds.y) / bounds.h)),
  };
}

export function contentToPixel(rx, ry, bounds) {
  return { x: rx * bounds.w + bounds.x, y: ry * bounds.h + bounds.y };
}
