/** Camera framing and label-placement maths, kept free of Three.js so it can be unit tested. */

/** Distance at which a sphere of `radius` just fits the view, for a vertical field of view and aspect ratio. */
export function framingDistance(radius: number, verticalFovDeg: number, aspect: number, margin = 1.15): number {
  const vertical = (verticalFovDeg * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(0.1, aspect));
  const limiting = Math.min(vertical, horizontal);
  return (radius * margin) / Math.sin(limiting / 2);
}

/**
 * Distance at which a box with the given half-extents (width, height, depth) fits the view, looking along
 * its depth axis. Better than a bounding sphere for a tall, thin object such as the wrist-to-heart route.
 */
export function boxFramingDistance(halfWidth: number, halfHeight: number, halfDepth: number, verticalFovDeg: number, aspect: number, margin = 1.1): number {
  const tanHalf = Math.tan((verticalFovDeg * Math.PI) / 360);
  const forHeight = halfHeight / tanHalf;
  const forWidth = halfWidth / (tanHalf * Math.max(0.1, aspect));
  return Math.max(forHeight, forWidth) * margin + halfDepth;
}

/** Labels of the heart's own anatomy are shown only when the camera is within this distance of its target, mm. */
export const HEART_LABEL_RANGE = 600;

/** Whether a label of the given scope is shown with the camera `distance` mm from its target. */
export function labelShownAt(scope: 'heart' | 'body', distance: number): boolean {
  return scope === 'body' || distance <= HEART_LABEL_RANGE;
}

/** Smooth ease for camera moves: 0 at the start, 1 at the end, gentle at both. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Whether a label at normalised device coordinates (x, y, z) is on screen and in front of the camera. */
export function isOnScreen(ndcX: number, ndcY: number, ndcZ: number, margin = 0.02): boolean {
  const limit = 1 - margin;
  return ndcZ > -1 && ndcZ < 1 && Math.abs(ndcX) <= limit && Math.abs(ndcY) <= limit;
}

/** Convert normalised device coordinates to CSS pixels within a box. */
export function ndcToPixels(ndcX: number, ndcY: number, width: number, height: number): { x: number; y: number } {
  return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height };
}

/** Cardiac cycle phase (0 to 1) for a time in seconds at a heart rate in beats per minute. */
export function cardiacPhase(seconds: number, beatsPerMinute: number): number {
  const period = 60 / Math.max(1, beatsPerMinute);
  const phase = (seconds % period) / period;
  return phase < 0 ? phase + 1 : phase;
}
