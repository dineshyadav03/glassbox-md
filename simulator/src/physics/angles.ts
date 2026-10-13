/** Angle helpers for tip rotation, in degrees. */

/** Wrap an angle into (-180, 180]. */
export function normalizeDeg(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** The smallest absolute difference between two angles, 0 to 180. */
export function angleDiffDeg(a: number, b: number): number {
  return Math.abs(normalizeDeg(a - b));
}
