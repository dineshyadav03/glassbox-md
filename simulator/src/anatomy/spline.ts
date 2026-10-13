/**
 * Splines and arc-length paths. A path is built from a few hand-placed control points,
 * smoothed with a centripetal Catmull-Rom spline (no overshoot or loops), then measured, so
 * a position can be asked for by distance along it. Pure maths.
 */
import { add, distance, lerp, normalize, scale, sub, type Vec3 } from './vec3';

/** Point on the centripetal Catmull-Rom curve between p1 and p2 at t in [0, 1]. */
export function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number, alpha = 0.5): Vec3 {
  const eps = 1e-6;
  const t0 = 0;
  const t1 = t0 + Math.max(eps, Math.pow(distance(p0, p1), alpha));
  const t2 = t1 + Math.max(eps, Math.pow(distance(p1, p2), alpha));
  const t3 = t2 + Math.max(eps, Math.pow(distance(p2, p3), alpha));
  const u = t1 + (t2 - t1) * t;

  const a1 = add(scale(p0, (t1 - u) / (t1 - t0)), scale(p1, (u - t0) / (t1 - t0)));
  const a2 = add(scale(p1, (t2 - u) / (t2 - t1)), scale(p2, (u - t1) / (t2 - t1)));
  const a3 = add(scale(p2, (t3 - u) / (t3 - t2)), scale(p3, (u - t2) / (t3 - t2)));
  const b1 = add(scale(a1, (t2 - u) / (t2 - t0)), scale(a2, (u - t0) / (t2 - t0)));
  const b2 = add(scale(a2, (t3 - u) / (t3 - t1)), scale(a3, (u - t1) / (t3 - t1)));
  return add(scale(b1, (t2 - u) / (t2 - t1)), scale(b2, (u - t1) / (t2 - t1)));
}

/** Dense points along the spline through the control points, passing through each of them. */
export function sampleSpline(controls: readonly Vec3[], samplesPerSegment = 24): Vec3[] {
  if (controls.length < 2) throw new Error('a spline needs at least two control points');
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  // Reflect the end points so the curve reaches the first and last control point with a natural tangent.
  const padded: Vec3[] = [sub(scale(first, 2), controls[1]!), ...controls, sub(scale(last, 2), controls[controls.length - 2]!)];
  const out: Vec3[] = [];
  for (let i = 1; i < padded.length - 2; i++) {
    for (let j = 0; j < samplesPerSegment; j++) {
      out.push(catmullRom(padded[i - 1]!, padded[i]!, padded[i + 1]!, padded[i + 2]!, j / samplesPerSegment));
    }
  }
  out.push(last);
  return out;
}

/** A polyline with cumulative distances, so positions and directions can be asked for by arc length. */
export class Path {
  readonly points: readonly Vec3[];
  /** Distance from the start to each point. */
  readonly cumulative: readonly number[];

  constructor(points: readonly Vec3[]) {
    if (points.length < 2) throw new Error('a path needs at least two points');
    this.points = points;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]! + distance(points[i - 1]!, points[i]!));
    this.cumulative = cumulative;
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1]!;
  }

  /** Index of the segment containing distance d (clamped), so that cumulative[i] <= d <= cumulative[i+1]. */
  private segmentAt(d: number): number {
    let lo = 0;
    let hi = this.cumulative.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumulative[mid]! <= d) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  positionAt(d: number): Vec3 {
    const clamped = Math.min(this.length, Math.max(0, d));
    const i = this.segmentAt(clamped);
    const span = this.cumulative[i + 1]! - this.cumulative[i]!;
    const t = span < 1e-12 ? 0 : (clamped - this.cumulative[i]!) / span;
    return lerp(this.points[i]!, this.points[i + 1]!, t);
  }

  /** Unit direction of travel at distance d. */
  tangentAt(d: number): Vec3 {
    const clamped = Math.min(this.length, Math.max(0, d));
    const i = this.segmentAt(clamped);
    const ahead = this.points[Math.min(this.points.length - 1, i + 1)]!;
    const behind = this.points[i]!;
    const direction = normalize(sub(ahead, behind));
    return direction;
  }

  /** The same path reversed (start becomes end). */
  reversed(): Path {
    return new Path([...this.points].reverse());
  }

  /** A piece of this path between two distances. */
  slice(from: number, to: number): Path {
    const a = Math.min(this.length, Math.max(0, from));
    const b = Math.min(this.length, Math.max(0, to));
    const inside: Vec3[] = [this.positionAt(a)];
    for (let i = 0; i < this.points.length; i++) {
      const d = this.cumulative[i]!;
      if (d > a + 1e-9 && d < b - 1e-9) inside.push(this.points[i]!);
    }
    inside.push(this.positionAt(b));
    return new Path(inside);
  }
}

/** A smooth path through hand-placed control points. */
export function smoothPath(controls: readonly Vec3[], samplesPerSegment = 24): Path {
  return new Path(sampleSpline(controls, samplesPerSegment));
}
