/**
 * Where everything is in 3D: the six coronary centrelines, the aorta, and the access route from the
 * right wrist to the aortic root. The rules of the simulator work on 1D "rails" (distance along a
 * vessel); this module maps each rail distance to a point in space, and its path lengths equal the
 * configured lengths exactly, so what the rules say and what is drawn cannot drift apart.
 *
 * World frame: x = patient's left, y = superior, z = anterior; 1 unit = 1 mm; heart centre at origin.
 * The control points are hand-placed and approximate: the arteries are then snapped onto the heart
 * surface, so only their rough course matters. The shapes are stylised, not anatomical measurements.
 */
import { ROUTE_SEGMENTS, VESSELS, VESSEL_ORDER, type VesselId } from '../config/anatomy';
import { snapToHeart } from './heartShape';
import { Path, sampleSpline } from './spline';
import { lerp, scale, add, type Vec3 } from './vec3';

/** Height of a coronary artery's centreline above the heart surface, mm (about its radius, so it sits half in the surface). */
export const CORONARY_LIFT = 1.2;

interface VesselPlan {
  /** Control points after the start. The start is the parent's point at `branchS`, or `start` for a root vessel. */
  readonly controls: readonly Vec3[];
  /** For a vessel arising from the aortic root: its ostium. */
  readonly start?: Vec3;
  /** Fraction of the vessel over which it eases from its start position onto the heart surface. */
  readonly easeOntoSurface: number;
}

// The aortic root centre, and the ostia (openings) of the two coronary arteries on it.
export const AORTIC_ROOT: Vec3 = [-2, 52, 8];
export const LEFT_OSTIUM: Vec3 = [12, 48, 12];
export const RIGHT_OSTIUM: Vec3 = [-16, 48, 14];

const PLANS: Readonly<Record<VesselId, VesselPlan>> = {
  LM: {
    start: LEFT_OSTIUM,
    controls: [[16, 45, 13.5], [20, 42, 16]],
    easeOntoSurface: 0.7,
  },
  LAD: {
    controls: [[17, 30, 27], [15, 14, 32], [16, -2, 34], [22, -18, 33], [30, -30, 30], [37, -39, 26], [41, -45, 20], [42, -50, 12]],
    easeOntoSurface: 0,
  },
  LCx: {
    controls: [[30, 38, 14], [45, 28, 4], [50, 14, -10], [48, -2, -26], [38, -12, -40], [22, -16, -48]],
    easeOntoSurface: 0,
  },
  D1: {
    controls: [[24, 10, 34], [34, 2, 28], [40, -8, 20], [43, -18, 12], [43, -28, 4]],
    easeOntoSurface: 0,
  },
  D2: {
    controls: [[30, -22, 30], [38, -30, 22], [42, -38, 12], [42, -46, 4]],
    easeOntoSurface: 0,
  },
  RCA: {
    start: RIGHT_OSTIUM,
    controls: [[-30, 40, 20], [-44, 24, 22], [-52, 4, 16], [-50, -16, 10], [-42, -30, 2], [-30, -40, -8], [-18, -44, -18]],
    easeOntoSurface: 0.2,
  },
};

const smooth = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Make a path exactly `target` long: cut it if too long, continue it straight on if too short. */
function fitToLength(path: Path, target: number): Path {
  if (path.length >= target) return path.slice(0, target);
  const end = path.positionAt(path.length);
  const direction = path.tangentAt(path.length);
  return new Path([...path.points, add(end, scale(direction, target - path.length))]);
}

interface BuiltVessel {
  readonly path: Path;
  /** Length of the smoothed, snapped control course before it was cut or extended to the configured length. */
  readonly naturalLength: number;
}

function buildVessel(id: VesselId, built: Partial<Record<VesselId, BuiltVessel>>): BuiltVessel {
  const spec = VESSELS[id];
  const plan = PLANS[id];
  const parent = spec.parent === null ? null : built[spec.parent];
  const start: Vec3 = parent ? parent.path.positionAt(spec.branchS) : plan.start!;
  const samples = sampleSpline([start, ...plan.controls], 24);
  const last = samples.length - 1;

  const onSurface = samples.map((p, i) => {
    if (i === 0) return p;
    const ease = plan.easeOntoSurface <= 0 ? 1 : smooth(i / last / plan.easeOntoSurface);
    return lerp(p, snapToHeart(p, CORONARY_LIFT), ease);
  });

  const natural = new Path(onSurface);
  return { path: fitToLength(natural, spec.length), naturalLength: natural.length };
}

// --- aorta and access route -----------------------------------------------------------------

/** Route controls from the aortic root outward to beyond the wrist; the far end is cut to length. */
const ROUTE_FROM_ROOT: readonly Vec3[] = [
  AORTIC_ROOT,
  [0, 84, 6],
  [4, 110, 0],
  [6, 126, -6],
  [-8, 140, -6],
  [-40, 152, -5],
  [-80, 158, -6],
  [-120, 160, -8],
  [-150, 150, -6],
  [-166, 134, -4],
  [-182, 80, 0],
  [-192, 0, 4],
  [-198, -120, 12],
  [-208, -250, 30],
  [-216, -380, 42],
  [-220, -470, 46],
];

/** Centreline of the aorta as drawn: root, ascending, arch, descending. */
const AORTA_CONTROLS: readonly Vec3[] = [
  AORTIC_ROOT,
  [0, 84, 6],
  [4, 110, 0],
  [10, 128, -12],
  [22, 132, -30],
  [32, 120, -44],
  [35, 96, -52],
  [35, 50, -56],
  [35, 0, -57],
  [35, -60, -57],
];

export const ROUTE_LENGTH: number = ROUTE_SEGMENTS.reduce((sum, seg) => sum + seg.length, 0);

/** Aorta radius, mm, by distance along its centreline: widest at the sinuses, narrowing along the arch. */
export function aortaRadiusAt(distance: number, total: number): number {
  const sinus = 17 - 2.5 * smooth(distance / 22);
  const taper = 1 - 0.25 * smooth((distance - 90) / Math.max(1, total - 90));
  return sinus * taper;
}

/** True arterial diameters of each access segment, mm (smoothed across segment boundaries). */
const SEGMENT_DIAMETER: Readonly<Record<(typeof ROUTE_SEGMENTS)[number]['id'], number>> = {
  radial: 2.6,
  brachial: 4.5,
  axillary: 6.5,
  subclavian: 8,
  brachiocephalic: 12,
  aorta: 28,
};

/** Lumen diameter of the access route at distance `s` from the wrist, mm. */
export function routeDiameterAt(s: number): number {
  const blend = 12;
  let boundary = 0;
  for (let i = 0; i < ROUTE_SEGMENTS.length; i++) {
    const here = SEGMENT_DIAMETER[ROUTE_SEGMENTS[i]!.id];
    boundary += ROUTE_SEGMENTS[i]!.length;
    const next = ROUTE_SEGMENTS[i + 1];
    if (next === undefined) return here;
    // Ease between this segment and the next across a window centred on the boundary between them.
    if (s < boundary - blend) return here;
    if (s < boundary + blend) {
      return here + (SEGMENT_DIAMETER[next.id] - here) * smooth((s - (boundary - blend)) / (2 * blend));
    }
  }
  return SEGMENT_DIAMETER.aorta;
}

export interface AnatomyPaths {
  readonly vessels: Readonly<Record<VesselId, Path>>;
  /** Length of each coronary's smoothed course before it was fitted to its configured length. */
  readonly naturalLengths: Readonly<Record<VesselId, number>>;
  /** The access route, s = 0 at the wrist, s = ROUTE_LENGTH at the aortic root. */
  readonly route: Path;
  /** Length of the route's course before it was fitted to its configured length. */
  readonly routeNaturalLength: number;
  /** The aorta as drawn (root to descending); the last stretch of the route lies inside it. */
  readonly aorta: Path;
}

let cached: AnatomyPaths | undefined;

export function buildAnatomyPaths(): AnatomyPaths {
  const built: Partial<Record<VesselId, BuiltVessel>> = {};
  for (const id of VESSEL_ORDER) built[id] = buildVessel(id, built);

  const vessels = {} as Record<VesselId, Path>;
  const naturalLengths = {} as Record<VesselId, number>;
  for (const id of VESSEL_ORDER) {
    vessels[id] = built[id]!.path;
    naturalLengths[id] = built[id]!.naturalLength;
  }

  const fromRoot = new Path(sampleSpline(ROUTE_FROM_ROOT, 20));
  const routeNaturalLength = fromRoot.length;
  // Fit at the wrist end so the far end of the route is exactly at the aortic root, then flip so s = 0 is the wrist.
  const route = fitToLength(fromRoot, ROUTE_LENGTH).reversed();

  return { vessels, naturalLengths, route, routeNaturalLength, aorta: new Path(sampleSpline(AORTA_CONTROLS, 20)) };
}

/** The anatomy, built once. */
export function anatomyPaths(): AnatomyPaths {
  cached ??= buildAnatomyPaths();
  return cached;
}

/** 3D position of a point `s` mm along a coronary vessel. */
export function vesselPosition(id: VesselId, s: number): Vec3 {
  return anatomyPaths().vessels[id].positionAt(s);
}

/** Unit direction of travel along a coronary vessel at `s`. */
export function vesselDirection(id: VesselId, s: number): Vec3 {
  return anatomyPaths().vessels[id].tangentAt(s);
}

/** 3D position `s` mm along the access route from the wrist. */
export function routePosition(s: number): Vec3 {
  return anatomyPaths().route.positionAt(s);
}
