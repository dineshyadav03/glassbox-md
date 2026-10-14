/**
 * Judging a clip: from its variant, angle and blade depth (and the anatomy it is placed on) to whether the neck is
 * closed, how much of it is left open, whether the carotid is narrowed, and whether the posterior communicating and
 * anterior choroidal arteries are still open. Pure functions of the config, so editing the anatomy moves the angles at
 * which a clip pinches a branch. All the thresholds are invented teaching choices (`RULES.clip`).
 *
 * The clip is a bar across the neck. Its angle is a turn about the neck's axis, measured from a fixed reference
 * direction; a bar is the same turned half a circle, so angles are compared modulo 180 degrees.
 */
import { ANATOMY } from '../config/anatomy';
import { RULES } from '../config/rules';
import { aneurysmGeometry } from '../anatomy/aneurysm';
import { buildVessels, icaPointBack } from '../anatomy/vessels';
import { anyPerpendicular, cross, dot, normalize, scale, sub, type Vec3 } from '../anatomy/vec3';

type Config = typeof ANATOMY;

export interface ClipSetupLike {
  readonly variant: 'straight' | 'curved';
  readonly angleDeg: number;
  readonly depth: number;
}

export interface ClipResult {
  /** The neck is closed (what is left open is under the tolerance). */
  readonly closed: boolean;
  /** How much of the neck is left open, mm. */
  readonly residualMm: number;
  /** How narrow the carotid has been made, percent. */
  readonly icaNarrowingPct: number;
  readonly pcomOpen: boolean;
  readonly achoaOpen: boolean;
  /** How far the clip is turned from lying along the parent artery, 0 to 90 degrees. */
  readonly angleErrorDeg: number;
}

/** The angle, in degrees within (-90, 90], at which a bar along `direction` lies, measured from the clip's reference direction. */
function barAngle(direction: Vec3, reference: Vec3, axis: Vec3): number {
  const side = cross(axis, reference);
  const flat = sub(direction, scale(axis, dot(direction, axis)));
  let deg = (Math.atan2(dot(flat, side), dot(flat, reference)) * 180) / Math.PI;
  while (deg > 90) deg -= 180;
  while (deg <= -90) deg += 180;
  return deg;
}

/** Difference between two bar angles, 0 to 90 degrees. */
export function barDifference(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

export interface ClipAngles {
  /** The angle at which the clip lies along the parent artery. */
  readonly ideal: number;
  /** The angle at which a deep clip points at the origin of the posterior communicating artery. */
  readonly pcom: number;
  /** The same for the anterior choroidal artery. */
  readonly achoa: number;
}

/** The angles that matter for this anatomy. */
export function clipAngles(config: Config = ANATOMY): ClipAngles {
  const g = aneurysmGeometry(config);
  const reference = anyPerpendicular(g.axis);
  const vessels = buildVessels(config);
  const ica = icaPointBack(config, config.aneurysm.junctionBackMm);
  const toward = (tubePoint: Vec3): number => barAngle(normalize(sub(tubePoint, g.neckCentre)), reference, g.axis);
  return {
    ideal: barAngle(ica.tangent, reference, g.axis),
    pcom: toward(vessels.pcom.path.positionAt(3)),
    achoa: toward(vessels.achoa.path.positionAt(3)),
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function evaluateClip(setup: ClipSetupLike, config: Config = ANATOMY): ClipResult {
  const k = RULES.clip;
  const angles = clipAngles(config);
  const curved = setup.variant === 'curved';
  const needed = curved ? k.neededDepthCurved : k.neededDepthStraight;
  const tolerance = curved ? k.toleranceCurvedDeg : k.toleranceStraightDeg;
  const error = barDifference(setup.angleDeg, angles.ideal);
  const neck = config.aneurysm.neckWidthMm;
  const beyond = error > tolerance ? (error - tolerance) / (90 - tolerance) : 0;

  const residualMm = neck * (1 - Math.min(1, setup.depth / needed)) + neck * k.misalignedResidual * beyond;
  const intrusion = clamp((setup.depth - k.intrusionDepth) / (1 - k.intrusionDepth), 0, 1);
  const icaNarrowingPct = k.intrusionNarrowing * intrusion + k.misalignedNarrowing * beyond * (curved ? 0.5 : 1);

  const deep = setup.depth >= k.pinchDepth;
  const pinches = (branch: number): boolean => deep && barDifference(setup.angleDeg, branch) < k.pinchAngleDeg;
  return {
    closed: residualMm < k.closedResidualMm,
    residualMm,
    icaNarrowingPct,
    pcomOpen: !pinches(angles.pcom),
    achoaOpen: !pinches(angles.achoa),
    angleErrorDeg: error,
  };
}

/** A clip that closes the neck cleanly and spares both branches, for tests and the demo. */
export function goodClip(config: Config = ANATOMY): ClipSetupLike {
  const angles = clipAngles(config);
  return { variant: 'straight', angleDeg: Math.round(angles.ideal), depth: 0.85 };
}
