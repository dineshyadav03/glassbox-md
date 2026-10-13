/**
 * The heart's outer surface, as a pure function, so the mesh, the coronary arteries that lie on it
 * and the beating animation all share one definition. World frame: x = patient's left, y = superior,
 * z = anterior; 1 unit = 1 mm; the heart's centre is the origin.
 *
 * It is a stylised heart, not a model of a real one: a tilted, tapered ellipsoid (apex pointing left,
 * forward and down) with a fuller right-ventricle border and a flatter base.
 */
import { cross, dot, normalize, scale, type Vec3 } from './vec3';

/** Semi-axes of the ellipsoid before tapering, mm (a heart is roughly 12 cm long and 9 cm wide). */
const WIDTH = 42;
const LENGTH = 60;
const DEPTH = 36;

/** Long axis, base to apex: points to the patient's left, forward and down. */
export const APEX_DIRECTION: Vec3 = normalize([0.62, -0.62, 0.48]);
/** Across the heart, roughly left and up; perpendicular to the long axis. */
const WIDTH_AXIS: Vec3 = normalize(cross([0, 0, 1], APEX_DIRECTION));
/** Front to back, roughly anterior. */
const DEPTH_AXIS: Vec3 = cross(APEX_DIRECTION, WIDTH_AXIS);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Heart-local coordinates of a world point: across, along the long axis (+ toward the apex), front to back. */
export function toHeartLocal(p: Vec3): Vec3 {
  return [dot(p, WIDTH_AXIS), dot(p, APEX_DIRECTION), dot(p, DEPTH_AXIS)];
}

/** Implicit surface value: below 1 is inside the heart, 1 is on the surface, above 1 is outside. */
export function heartField(p: Vec3): number {
  const [x, y, z] = toHeartLocal(p);
  const along = y / LENGTH;
  // Narrower toward the apex, so it comes to a blunt point rather than an egg's round end.
  const taper = 1 - 0.42 * smooth(-0.3, 1, along);
  // Fuller on the right-ventricle side (the negative width side).
  const rvBulge = x < 0 ? 1 + 0.16 * smooth(0, 1, -x / WIDTH) : 1;
  const across = x / (WIDTH * taper * rvBulge);
  const back = z / (DEPTH * taper);
  // A flatter base (higher exponent on the base side) than the apex side.
  const exponent = along < 0 ? 3 : 2;
  return across * across + back * back + Math.pow(Math.abs(along), exponent);
}

/** Distance from the centre to the surface along a direction (need not be unit). */
export function heartRadius(direction: Vec3): number {
  const d = normalize(direction);
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return 0;
  let lo = 0;
  let hi = 200;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (heartField(scale(d, mid)) < 1) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The surface point in a direction from the centre, lifted outward by `lift` mm. */
export function heartSurfacePoint(direction: Vec3, lift = 0): Vec3 {
  const d = normalize(direction);
  return scale(d, heartRadius(d) + lift);
}

/** Project a point radially onto the surface (plus `lift` mm outward). Idempotent for the same lift. */
export function snapToHeart(p: Vec3, lift = 0): Vec3 {
  return heartSurfacePoint(p, lift);
}

/**
 * How much of the epicardial fat (the pale tissue that lies in the grooves where the coronary arteries
 * run) covers a surface point: 0 to 1. Two grooves: between the atria and ventricles (around the base)
 * and between the two ventricles (down the front toward the apex).
 */
export function fatWeight(p: Vec3): number {
  const [x, y, z] = toHeartLocal(p);
  const along = y / LENGTH;
  const avGroove = Math.exp(-Math.pow((along + 0.22) / 0.13, 2));
  // The interventricular groove runs down the front: width coordinate near -0.2 of the semi-axis, anterior side.
  const front = smooth(0, 0.4, z / DEPTH);
  const ivGroove = Math.exp(-Math.pow((x + 0.2 * WIDTH) / 7, 2)) * front * smooth(-0.4, 0.1, along);
  return Math.min(1, Math.max(avGroove, ivGroove));
}

// --- the beat -------------------------------------------------------------------------------

/** Fraction of the cardiac cycle spent in systole (squeezing). */
export const SYSTOLE_FRACTION = 0.38;
/** How much the heart shrinks, end-diastole to end-systole, as a fraction of its size. */
export const BEAT_SHRINK = 0.07;

/**
 * Scale of the heart at a point in the cardiac cycle (`phase` 0 to 1, wrapping): 1 when relaxed,
 * down to 1 - BEAT_SHRINK at the end of systole. A quick squeeze, then a slower relaxation.
 */
export function beatFactor(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const squeeze =
    p < SYSTOLE_FRACTION
      ? 0.5 - 0.5 * Math.cos((Math.PI * p) / SYSTOLE_FRACTION)
      : 0.5 + 0.5 * Math.cos((Math.PI * (p - SYSTOLE_FRACTION)) / (1 - SYSTOLE_FRACTION));
  return 1 - BEAT_SHRINK * squeeze;
}
