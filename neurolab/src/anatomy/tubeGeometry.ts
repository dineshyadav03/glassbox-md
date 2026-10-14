/**
 * Tube meshes along a path, as plain typed arrays (so they can be built and tested without WebGL, then
 * handed to Three.js). The frames are fixed once; the radius is a function of distance along the path
 * and can be re-applied later, which is how a vessel will narrow and widen as devices change its lumen.
 */
import { Path } from './spline';
import { add, anyPerpendicular, cross, dot, normalize, rotateAbout, scale, sub, type Vec3 } from './vec3';

export interface TubeOptions {
  /** Vertices around the circumference. */
  readonly radialSegments?: number;
  /** Distance between rings along the path, mm. */
  readonly step?: number;
}

export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

interface Station {
  readonly s: number;
  readonly centre: Vec3;
  readonly tangent: Vec3;
  /** Two perpendicular unit vectors spanning the cross-section. */
  readonly u: Vec3;
  readonly v: Vec3;
}

export type Colour = readonly [number, number, number];

export class TubeTemplate {
  readonly radialSegments: number;
  private readonly stations: readonly Station[];

  constructor(readonly path: Path, options: TubeOptions = {}) {
    this.radialSegments = Math.max(3, options.radialSegments ?? 14);
    const step = Math.max(0.05, options.step ?? 1);
    const count = Math.max(2, Math.ceil(path.length / step) + 1);
    this.stations = buildStations(path, count);
  }

  get ringCount(): number {
    return this.stations.length;
  }

  get vertexCount(): number {
    return this.stations.length * this.radialSegments;
  }

  /** Distance along the path of each ring. */
  ringDistances(): number[] {
    return this.stations.map((st) => st.s);
  }

  /** Triangle indices; they do not depend on the radius. */
  indices(): Uint32Array {
    const n = this.radialSegments;
    const out = new Uint32Array((this.stations.length - 1) * n * 6);
    let k = 0;
    for (let i = 0; i < this.stations.length - 1; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * n + j;
        const b = i * n + ((j + 1) % n);
        const c = (i + 1) * n + j;
        const d = (i + 1) * n + ((j + 1) % n);
        out[k++] = a;
        out[k++] = c;
        out[k++] = b;
        out[k++] = b;
        out[k++] = c;
        out[k++] = d;
      }
    }
    return out;
  }

  /** Write vertex positions and normals for the given radius (mm) at each distance along the path. */
  fill(radiusAt: (s: number) => number, positions: Float32Array, normals: Float32Array): void {
    const n = this.radialSegments;
    const radii = this.stations.map((st) => Math.max(0, radiusAt(st.s)));
    for (let i = 0; i < this.stations.length; i++) {
      const st = this.stations[i]!;
      const r = radii[i]!;
      // Slope of the radius along the path tilts the surface normal, so a tapering vessel shades correctly.
      const before = radii[Math.max(0, i - 1)]!;
      const after = radii[Math.min(this.stations.length - 1, i + 1)]!;
      const ds = this.stations[Math.min(this.stations.length - 1, i + 1)]!.s - this.stations[Math.max(0, i - 1)]!.s;
      const slope = ds > 1e-9 ? (after - before) / ds : 0;
      for (let j = 0; j < n; j++) {
        const angle = (2 * Math.PI * j) / n;
        const radial = add(scale(st.u, Math.cos(angle)), scale(st.v, Math.sin(angle)));
        const p = add(st.centre, scale(radial, r));
        const normal = normalize(sub(radial, scale(st.tangent, slope)));
        const idx = (i * n + j) * 3;
        positions[idx] = p[0];
        positions[idx + 1] = p[1];
        positions[idx + 2] = p[2];
        normals[idx] = normal[0];
        normals[idx + 1] = normal[1];
        normals[idx + 2] = normal[2];
      }
    }
  }

  /** Write a colour for every vertex from a function of distance along the path. */
  fillColours(colourAt: (s: number) => Colour, colors: Float32Array): void {
    const n = this.radialSegments;
    for (let i = 0; i < this.stations.length; i++) {
      const c = colourAt(this.stations[i]!.s);
      for (let j = 0; j < n; j++) {
        const idx = (i * n + j) * 3;
        colors[idx] = c[0];
        colors[idx + 1] = c[1];
        colors[idx + 2] = c[2];
      }
    }
  }
}

/** Frames spaced evenly in distance, carried along by parallel transport so they never twist. */
function buildStations(path: Path, count: number): Station[] {
  const stations: Station[] = [];
  let u: Vec3 | undefined;
  let previousTangent: Vec3 | undefined;
  for (let i = 0; i < count; i++) {
    const s = (path.length * i) / (count - 1);
    const tangent = normalize(path.tangentAt(s));
    if (u === undefined || previousTangent === undefined) {
      u = anyPerpendicular(tangent);
    } else {
      const axis = cross(previousTangent, tangent);
      const sinAngle = Math.hypot(axis[0], axis[1], axis[2]);
      if (sinAngle > 1e-9) {
        const angle = Math.atan2(sinAngle, dot(previousTangent, tangent));
        u = rotateAbout(u, normalize(axis), angle);
      }
      // Remove any drift so u stays exactly perpendicular to the tangent.
      u = normalize(sub(u, scale(tangent, dot(u, tangent))));
    }
    previousTangent = tangent;
    stations.push({ s, centre: path.positionAt(s), tangent, u, v: cross(tangent, u) });
  }
  return stations;
}

/** Build a whole tube at once. */
export function buildTube(
  path: Path,
  radiusAt: (s: number) => number,
  colourAt: (s: number) => Colour,
  options: TubeOptions = {},
): MeshData {
  const template = new TubeTemplate(path, options);
  const positions = new Float32Array(template.vertexCount * 3);
  const normals = new Float32Array(template.vertexCount * 3);
  const colors = new Float32Array(template.vertexCount * 3);
  template.fill(radiusAt, positions, normals);
  template.fillColours(colourAt, colors);
  return { positions, normals, colors, indices: template.indices() };
}
