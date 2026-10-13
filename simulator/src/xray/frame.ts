/**
 * What an X-ray image of the current case shows, as a list of shapes in image pixels. Pure: it projects
 * the 3D anatomy and devices through a C-arm camera and decides what is visible (bones and the heart's
 * shadow always; catheters and wires only while the beam is on; dye only during a contrast run). The
 * canvas code only paints these shapes, so everything that matters can be tested without a browser.
 */
import { ELBOW_S, LEFT_SYSTEM, LESION, STENT, type VesselId } from '../config/anatomy';
import { anatomyPaths, aortaRadiusAt } from '../anatomy/centrelines';
import { beatFactor, heartSurfacePoint } from '../anatomy/heartShape';
import { Path } from '../anatomy/spline';
import { scale, type Vec3 } from '../anatomy/vec3';
import { treatmentsOf, type Simulation } from '../engine/simulation';
import { cardiacPhase } from '../physics/ecg';
import { lumenDiameterAt } from '../physics/lesion';
import { inflatedDiameter } from '../tools/devices';
import { buildChainPath, buildGuidePath, chainDistance, dyeFill, flapWeight, routeFor, suggestedDistance, focusPoint } from '../scene/deviceMath';
import { project, makeCamera, type Camera, type CArmAngles } from './projection';

export type Shade = 'tissue' | 'bone' | 'catheter' | 'wire' | 'marker' | 'stent' | 'balloon' | 'dye';

export interface Line {
  readonly kind: 'line';
  readonly shade: Shade;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Width in image pixels. */
  readonly width: number;
  readonly alpha: number;
}

export interface Polygon {
  readonly kind: 'polygon';
  readonly shade: Shade;
  /** x0, y0, x1, y1, ... */
  readonly points: readonly number[];
  readonly alpha: number;
}

export type Prim = Line | Polygon;

export interface XrayFrame {
  readonly backdrop: readonly Prim[];
  readonly devices: readonly Prim[];
  readonly dye: readonly Prim[];
  /** Total dye shown (width x alpha summed), to find the best-filled frame of a run. */
  readonly dyeAmount: number;
}

export interface XrayMode {
  /** The beam is on (pedal down, or a recorded run is being acquired): a fresh image is being made. */
  readonly live: boolean;
  /** Dye is visible in the image. */
  readonly showDye: boolean;
}

/** Is the image live, and is there dye in it? */
export function xrayMode(sim: Simulation): XrayMode {
  const run = sim.injection;
  const acquiring = run !== null && run.recorded;
  const live = sim.fluoroOn || acquiring;
  return { live, showDye: run !== null && (run.recorded || sim.fluoroOn) };
}

/** How wide the image field should be, mm: wide for the arm, tight on the coronary arteries. */
export function fieldOfViewMm(sim: Simulation): number {
  return suggestedDistance(sim) * 1.25;
}

export function xrayCentre(sim: Simulation): Vec3 {
  return focusPoint(sim);
}

// --- small geometry helpers ------------------------------------------------------------------------------------------

const cross2 = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** The convex hull of 2D points (monotone chain), counter-clockwise. */
export function convexHull(points: readonly (readonly [number, number])[]): [number, number][] {
  const pts = [...points].map((p) => [p[0], p[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross2(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function flat(points: readonly (readonly [number, number])[]): number[] {
  return points.flatMap((p) => [p[0], p[1]]);
}

let heartCloud: Vec3[] | null = null;
/** Points over the heart's surface, for its shadow. */
function heartPoints(): Vec3[] {
  if (heartCloud) return heartCloud;
  const out: Vec3[] = [];
  for (let i = 0; i <= 14; i++) {
    const polar = (Math.PI * i) / 14;
    for (let j = 0; j < 28; j++) {
      const az = (2 * Math.PI * j) / 28;
      out.push(heartSurfacePoint([Math.sin(polar) * Math.cos(az), Math.cos(polar), Math.sin(polar) * Math.sin(az)]));
    }
  }
  heartCloud = out;
  return out;
}

/** Points along a path every `step` mm, including both ends. */
function sampleSegment(path: Path, step: number): Vec3[] {
  const out: Vec3[] = [];
  for (let d = 0; d < path.length; d += step) out.push(path.positionAt(d));
  out.push(path.positionAt(path.length));
  return out;
}

const samplesCache = new Map<string, Vec3[]>();
function samplesAlong(key: string, path: Path, step: number): Vec3[] {
  const hit = samplesCache.get(key);
  if (hit) return hit;
  const out = sampleSegment(path, step);
  samplesCache.set(key, out);
  return out;
}

// --- the fixed backdrop: ribs, spine, arm bones, the heart's shadow ---------------------------------------------------------

function backdrop(camera: Camera, beat: number): Prim[] {
  const prims: Prim[] = [];
  const px = camera.pxPerMm;
  const at = (p: Vec3) => project(camera, p);

  // The heart's shadow.
  const hull = convexHull(heartPoints().map((p) => {
    const q = at(scale(p, beat));
    return [q.x, q.y] as const;
  }));
  if (hull.length >= 3) prims.push({ kind: 'polygon', shade: 'tissue', points: flat(hull), alpha: 0.4 });

  // The spine: a column of vertebrae behind the heart, with gaps for the discs.
  for (let i = 0; i < 16; i++) {
    const y = -180 + i * 24;
    const corners: [number, number][] = [];
    for (const dx of [-17, 17]) for (const dy of [-9, 9]) for (const dz of [-14, 14]) {
      const q = at([dx, y + dy, -78 + dz]);
      corners.push([q.x, q.y]);
    }
    const body = convexHull(corners);
    if (body.length >= 3) prims.push({ kind: 'polygon', shade: 'bone', points: flat(body), alpha: 0.42 });
    const a = at([0, y, -92]);
    const b = at([0, y, -122]);
    prims.push({ kind: 'line', shade: 'bone', x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: Math.max(1.5, 5 * px), alpha: 0.3 });
  }

  // Ribs, curving round from the spine to the front, sloping down.
  for (let k = 0; k < 8; k++) {
    const y = 110 - k * 26;
    for (const side of [-1, 1]) {
      let previous: ReturnType<typeof at> | null = null;
      for (let step = 0; step <= 18; step++) {
        const t = (0.86 * Math.PI * step) / 18;
        const q = at([side * 128 * Math.sin(t), y - 34 * (t / Math.PI), -8 - 70 * Math.cos(t)]);
        if (previous) prims.push({ kind: 'line', shade: 'bone', x1: previous.x, y1: previous.y, x2: q.x, y2: q.y, width: Math.max(1.4, 7 * px), alpha: 0.26 });
        previous = q;
      }
    }
  }

  // The bones of the right arm, behind the artery along the route; and the collar bone.
  const { route } = anatomyPaths();
  const bone = (from: number, to: number, widthMm: number, key: string): void => {
    const pts = samplesAlong(key, route.slice(from, to), 6);
    for (let i = 1; i < pts.length; i++) {
      const a = at([pts[i - 1]![0], pts[i - 1]![1], pts[i - 1]![2] - 12]);
      const b = at([pts[i]![0], pts[i]![1], pts[i]![2] - 12]);
      prims.push({ kind: 'line', shade: 'bone', x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: Math.max(2, widthMm * px), alpha: 0.4 });
    }
  };
  bone(8, ELBOW_S - 8, 11, 'forearm');
  bone(ELBOW_S + 8, ELBOW_S + 255, 15, 'humerus');
  const clavicleFrom = at([-4, 150, 22]);
  const clavicleTo = at(route.positionAt(ELBOW_S + 270 + 40));
  prims.push({ kind: 'line', shade: 'bone', x1: clavicleFrom.x, y1: clavicleFrom.y, x2: clavicleTo.x, y2: clavicleTo.y, width: Math.max(2, 9 * px), alpha: 0.4 });

  return prims;
}

// --- devices ---------------------------------------------------------------------------------------------------------------

function polyline(prims: Prim[], pts: readonly (readonly [number, number])[], shade: Shade, width: number, alpha: number): void {
  for (let i = 1; i < pts.length; i++) {
    prims.push({ kind: 'line', shade, x1: pts[i - 1]![0], y1: pts[i - 1]![1], x2: pts[i]![0], y2: pts[i]![1], width, alpha });
  }
}

/** Points of a coronary route up to a rail distance, beating with the heart. */
function routePoints(camera: Camera, vessel: VesselId, upTo: number, beat: number): [number, number][] {
  const path = buildChainPathCached(routeFor(vessel));
  const stop = Math.min(path.length, Math.max(0, upTo));
  const pts: [number, number][] = [];
  for (let d = 0; d < stop; d += 1.5) {
    const q = project(camera, scale(path.positionAt(d), beat));
    pts.push([q.x, q.y]);
  }
  const end = project(camera, scale(path.positionAt(stop), beat));
  pts.push([end.x, end.y]);
  return pts;
}

const chainCache = new Map<VesselId, Path>();
function buildChainPathCached(vessel: VesselId): Path {
  let path = chainCache.get(vessel);
  if (!path) {
    path = buildChainPath(vessel);
    chainCache.set(vessel, path);
  }
  return path;
}

let guideCache: Path | null = null;

function devices(sim: Simulation, camera: Camera, beat: number): Prim[] {
  const prims: Prim[] = [];
  const px = camera.pxPerMm;
  const ladPath = anatomyPaths().vessels[LESION.vessel];

  // The guide catheter, wrist to tip.
  guideCache ??= buildGuidePath();
  const guide = guideCache;
  const route = anatomyPaths().route;
  const shown = Math.min(sim.guide.s, route.length) + (sim.guide.engaged ? guide.length - route.length : 0);
  if (shown > 0.5) {
    const pts: [number, number][] = [];
    for (let d = 0; d < shown; d += 3) {
      const q = project(camera, guide.positionAt(d));
      pts.push([q.x, q.y]);
    }
    const tip = project(camera, guide.positionAt(shown));
    pts.push([tip.x, tip.y]);
    polyline(prims, pts, 'catheter', Math.max(1.8, 2.0 * px), 0.85);
    // A radiopaque tip band.
    const a = project(camera, guide.positionAt(Math.max(0, shown - 4)));
    prims.push({ kind: 'line', shade: 'marker', x1: a.x, y1: a.y, x2: tip.x, y2: tip.y, width: Math.max(2.6, 2.4 * px), alpha: 0.95 });
  }

  // The wire along the branch it took.
  const wire = sim.wire;
  if (wire.outOfGuide && wire.vessel !== null) {
    const pts = routePoints(camera, wire.vessel, chainDistance(wire.vessel, wire.s), beat);
    polyline(prims, pts, 'wire', Math.max(1, 0.5 * px), 0.9);
  }

  // Balloon and stent catheters: shaft, the balloon's outline when swollen, and two marker bands.
  for (const c of [sim.balloon, sim.stent]) {
    if (c.inGuide || c.ruptured || c.centreS === null) continue;
    const half = c.spec.length / 2;
    const from = c.centreS - half;
    const to = c.centreS + half;
    const shaft = routePoints(camera, LESION.vessel, chainDistance(LESION.vessel, from), beat);
    polyline(prims, shaft, 'catheter', Math.max(1, 0.9 * px), 0.55);

    const pts = sampleSegment(ladPath.slice(from, to), 1).map((p) => {
      const q = project(camera, scale(p, beat));
      return [q.x, q.y] as [number, number];
    });
    const diameter = inflatedDiameter(c.spec, c.pressure);
    polyline(prims, pts, 'balloon', Math.max(1.5, diameter * px), 0.22);
    for (const end of [0, pts.length - 1]) {
      const here = pts[end]!;
      const next = pts[Math.min(pts.length - 1, Math.max(0, end === 0 ? 1 : end - 1))]!;
      const dx = next[0] - here[0];
      const dy = next[1] - here[1];
      const norm = Math.hypot(dx, dy) || 1;
      const half2 = Math.max(2.5, (diameter / 2 + 0.5) * px);
      prims.push({ kind: 'line', shade: 'marker', x1: here[0] - (dy / norm) * half2, y1: here[1] + (dx / norm) * half2, x2: here[0] + (dy / norm) * half2, y2: here[1] - (dx / norm) * half2, width: Math.max(2, 1.2 * px), alpha: 0.95 });
    }
    if (c.spec.kind === 'stent' && !c.deployed) addStent(prims, pts, diameter, px);
  }

  // Deployed stents stay in the picture.
  for (const t of treatmentsOf(sim).filter((x) => x.kind === 'stent')) {
    const path = anatomyPaths().vessels[t.vessel].slice(t.centreS - t.length / 2, t.centreS + t.length / 2);
    const pts = sampleSegment(path, 1).map((p) => {
      const q = project(camera, scale(p, beat));
      return [q.x, q.y] as [number, number];
    });
    addStent(prims, pts, t.diameter * (1 - STENT.recoil), px);
  }
  return prims;
}

/** Stent struts: two edges and cross-ticks, so a stent reads as a mesh tube. */
function addStent(prims: Prim[], pts: readonly [number, number][], diameter: number, px: number): void {
  const half = Math.max(1.6, (diameter / 2) * px);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const norm = Math.hypot(dx, dy) || 1;
    const nx = -dy / norm;
    const ny = dx / norm;
    if (i % 2 === 0) {
      prims.push({ kind: 'line', shade: 'stent', x1: a[0] + nx * half, y1: a[1] + ny * half, x2: a[0] - nx * half, y2: a[1] - ny * half, width: 1, alpha: 0.75 });
    }
    prims.push({ kind: 'line', shade: 'stent', x1: a[0] + nx * half, y1: a[1] + ny * half, x2: b[0] + nx * half, y2: b[1] + ny * half, width: 1, alpha: 0.8 });
    prims.push({ kind: 'line', shade: 'stent', x1: a[0] - nx * half, y1: a[1] - ny * half, x2: b[0] - nx * half, y2: b[1] - ny * half, width: 1, alpha: 0.8 });
  }
}

/**
 * How dark the dye is at a point of a vessel right now, 0 to 1: the fill from the contrast run, with a
 * filling defect where a wall tear lets dye escape (stronger when the tear is not sealed by a stent).
 */
export function dyeAlpha(sim: Simulation, id: VesselId, s: number): number {
  const run = sim.injection;
  if (!run || !run.result) return 0;
  const elapsed = sim.time - run.start;
  let alpha = dyeFill(run.result.arrival[id] ?? [], run.result.factor[id] ?? [], s, elapsed, run.duration);
  for (const d of sim.dissections) {
    if (d.vessel === id) alpha *= 1 - (d.sealed ? 0.2 : 0.55) * flapWeight(d.s, s);
  }
  return Math.min(1, alpha);
}

// --- dye ------------------------------------------------------------------------------------------------------------------------

function dye(sim: Simulation, camera: Camera, beat: number): { prims: Prim[]; amount: number } {
  const run = sim.injection;
  const prims: Prim[] = [];
  let amount = 0;
  if (!run) return { prims, amount };
  const elapsed = sim.time - run.start;
  const px = camera.pxPerMm;
  const treatments = treatmentsOf(sim);

  if (!run.selective || !run.result) {
    // An aortic flush: the root and the ascending aorta fill, then clear.
    const { aorta } = anatomyPaths();
    const fade = Math.max(0, 1 - elapsed / run.duration);
    const pts: [number, number][] = [];
    for (let d = 0; d < Math.min(70, aorta.length); d += 3) {
      const q = project(camera, aorta.positionAt(d));
      pts.push([q.x, q.y]);
    }
    for (let i = 1; i < pts.length; i++) {
      const radius = aortaRadiusAt(i * 3, aorta.length);
      const alpha = 0.55 * fade;
      prims.push({ kind: 'line', shade: 'dye', x1: pts[i - 1]![0], y1: pts[i - 1]![1], x2: pts[i]![0], y2: pts[i]![1], width: radius * 1.9 * px, alpha });
      amount += alpha * radius;
    }
    return { prims, amount };
  }

  for (const id of LEFT_SYSTEM) {
    const path = anatomyPaths().vessels[id];
    let previous: ReturnType<typeof project> | null = null;
    for (let s = 0; s <= path.length + 1e-9; s += 1) {
      const here = Math.min(s, path.length);
      const q = project(camera, scale(path.positionAt(here), beat));
      if (previous) {
        const alpha = dyeAlpha(sim, id, here);
        const width = Math.max(1.1, lumenDiameterAt(id, here, treatments) * px);
        if (alpha > 0.02) {
          prims.push({ kind: 'line', shade: 'dye', x1: previous.x, y1: previous.y, x2: q.x, y2: q.y, width, alpha: Math.min(1, alpha) });
          amount += alpha * width;
        }
      }
      previous = q;
    }
  }
  return { prims, amount };
}

// --- the whole frame ----------------------------------------------------------------------------------------------------------

/** The heart's size on the screen at this moment of the case, following the patient's own heart rate. */
export function beatScale(sim: Simulation, heartRate: number): number {
  return beatFactor(cardiacPhase(sim.time, heartRate));
}

export interface FrameOptions {
  readonly angles: CArmAngles;
  readonly centre: Vec3;
  readonly fieldMm: number;
  readonly size: number;
  readonly heartRate: number;
}

export function buildXrayFrame(sim: Simulation, options: FrameOptions): XrayFrame {
  const camera = makeCamera(options.angles, options.centre, options.fieldMm, options.size);
  const mode = xrayMode(sim);
  const beat = beatScale(sim, options.heartRate);
  const back = backdrop(camera, beat);
  const dev = mode.live ? devices(sim, camera, beat) : [];
  const dyed = mode.showDye ? dye(sim, camera, beat) : { prims: [], amount: 0 };
  return { backdrop: back, devices: dev, dye: dyed.prims, dyeAmount: dyed.amount };
}
