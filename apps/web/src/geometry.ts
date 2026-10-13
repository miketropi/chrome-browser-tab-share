export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Largest rectangle with the source aspect ratio, centred inside the box.
 * Returns null when either input cannot produce a usable rectangle.
 */
export function containRect(box: Box, aspect: number): Box | null {
  if (!Number.isFinite(box.left) || !Number.isFinite(box.top)) return null;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  if (!Number.isFinite(aspect) || !(aspect > 0)) return null;
  const boxAspect = box.width / box.height;
  const width = boxAspect > aspect ? box.height * aspect : box.width;
  const height = width / aspect;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
}

/** Normalized viewport coordinates, or null when the point falls in the letterbox or outside the rectangle. */
export function normalizePoint(rect: Box, x: number, y: number): { u: number; v: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const u = (x - rect.left) / rect.width;
  const v = (y - rect.top) / rect.height;
  if (!(u >= 0) || u > 1 || !(v >= 0) || v > 1) return null;
  return { u, v };
}

/** Inverse of normalizePoint for the same rectangle; the host applies this against its viewport. */
export function denormalizePoint(rect: Box, u: number, v: number): { x: number; y: number } {
  return { x: rect.left + u * rect.width, y: rect.top + v * rect.height };
}
