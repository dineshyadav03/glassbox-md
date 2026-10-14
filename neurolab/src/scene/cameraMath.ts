/** Small pure helpers for the microscope camera. */

/** Smooth start and stop for a camera move: 0 to 1 in, 0 to 1 out. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** The largest swing away from straight-on, as radians, kept within a sensible range (a config typo cannot flip the camera). */
export function clampSwing(degrees: number): number {
  const safe = Math.min(80, Math.max(5, degrees));
  return (safe * Math.PI) / 180;
}

/**
 * Vertical field of view for a window of the given aspect ratio. The configured value is for a landscape window; in a
 * narrow or portrait window it is widened so the field is never narrower than it is in a 1.4:1 window (otherwise the
 * deep vessels fall off the sides).
 */
export function fovFor(configuredDeg: number, aspect: number): number {
  const rad = (configuredDeg * Math.PI) / 180;
  const narrowest = Math.tan(rad / 2) * 1.4;
  const needed = 2 * Math.atan(narrowest / Math.max(0.2, aspect));
  return Math.min(70, Math.max(configuredDeg, (needed * 180) / Math.PI));
}
