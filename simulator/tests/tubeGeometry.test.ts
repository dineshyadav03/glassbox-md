import { describe, expect, it } from 'vitest';
import { Path, smoothPath } from '../src/anatomy/spline';
import { TubeTemplate, buildTube } from '../src/anatomy/tubeGeometry';
import { distance, dot, length, sub, type Vec3 } from '../src/anatomy/vec3';

const point = (a: Float32Array, i: number): Vec3 => [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
const white = () => [1, 1, 1] as const;

const STRAIGHT = new Path([[0, 0, 0], [0, 0, 50]]);
const BENT = smoothPath([[0, 0, 0], [20, 0, 10], [30, 20, 10], [30, 40, 30], [10, 50, 50]], 20);

describe('TubeTemplate', () => {
  it('has the right vertex and index counts', () => {
    const t = new TubeTemplate(STRAIGHT, { radialSegments: 8, step: 5 });
    expect(t.ringCount).toBe(11);
    expect(t.vertexCount).toBe(88);
    expect(t.indices().length).toBe(10 * 8 * 6);
  });

  it('only uses vertex indices that exist', () => {
    const t = new TubeTemplate(BENT, { radialSegments: 10, step: 2 });
    const max = Math.max(...t.indices());
    expect(max).toBeLessThan(t.vertexCount);
  });

  it('puts every vertex of a ring at the requested radius from the centreline', () => {
    const mesh = buildTube(STRAIGHT, () => 1.5, white, { radialSegments: 12, step: 5 });
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const p = point(mesh.positions, i);
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(1.5, 5);
    }
  });

  it('follows a changing radius', () => {
    const mesh = buildTube(STRAIGHT, (s) => 1 + s / 50, white, { radialSegments: 6, step: 10 });
    const first = point(mesh.positions, 0);
    const lastRing = point(mesh.positions, mesh.positions.length / 3 - 1);
    expect(Math.hypot(first[0], first[1])).toBeCloseTo(1, 5);
    expect(Math.hypot(lastRing[0], lastRing[1])).toBeCloseTo(2, 5);
  });

  it('keeps ring radius around a bend (no pinching or twisting)', () => {
    const t = new TubeTemplate(BENT, { radialSegments: 16, step: 1 });
    const positions = new Float32Array(t.vertexCount * 3);
    const normals = new Float32Array(t.vertexCount * 3);
    t.fill(() => 2, positions, normals);
    for (let i = 0; i < t.ringCount; i++) {
      const s = t.ringDistances()[i]!;
      const centre = BENT.positionAt(s);
      for (let j = 0; j < 16; j++) {
        expect(distance(point(positions, i * 16 + j), centre)).toBeCloseTo(2, 4);
      }
    }
  });

  it('does not twist: the same vertex index moves little from ring to ring', () => {
    const t = new TubeTemplate(BENT, { radialSegments: 16, step: 1 });
    const positions = new Float32Array(t.vertexCount * 3);
    const normals = new Float32Array(t.vertexCount * 3);
    t.fill(() => 2, positions, normals);
    for (let i = 1; i < t.ringCount; i++) {
      const a = point(positions, (i - 1) * 16);
      const b = point(positions, i * 16);
      // About one step along plus a little sideways; a twisting frame would swing the vertex around the ring (up to 4 mm).
      expect(distance(a, b)).toBeLessThan(2.4);
    }
  });

  it('gives unit normals that point away from the axis and across the tube', () => {
    const t = new TubeTemplate(BENT, { radialSegments: 12, step: 2 });
    const positions = new Float32Array(t.vertexCount * 3);
    const normals = new Float32Array(t.vertexCount * 3);
    t.fill(() => 2, positions, normals);
    for (let i = 0; i < t.ringCount; i++) {
      const s = t.ringDistances()[i]!;
      const centre = BENT.positionAt(s);
      const tangent = BENT.tangentAt(s);
      for (let j = 0; j < 12; j++) {
        const n = point(normals, i * 12 + j);
        const out = sub(point(positions, i * 12 + j), centre);
        expect(length(n)).toBeCloseTo(1, 4);
        expect(dot(n, out)).toBeGreaterThan(0);
        expect(Math.abs(dot(n, tangent))).toBeLessThan(0.05);
      }
    }
  });

  it('tilts normals on a tapering tube', () => {
    const t = new TubeTemplate(STRAIGHT, { radialSegments: 8, step: 5 });
    const positions = new Float32Array(t.vertexCount * 3);
    const normals = new Float32Array(t.vertexCount * 3);
    t.fill((s) => 3 - s / 25, positions, normals);
    // Narrowing along +z: the surface faces slightly toward +z, so the normal has a positive z component.
    expect(point(normals, 4 * 8)[2]).toBeGreaterThan(0.02);
  });

  it('can be refilled with a new radius without rebuilding (how devices will change the lumen)', () => {
    const t = new TubeTemplate(STRAIGHT, { radialSegments: 8, step: 5 });
    const positions = new Float32Array(t.vertexCount * 3);
    const normals = new Float32Array(t.vertexCount * 3);
    t.fill(() => 1, positions, normals);
    const before = Math.hypot(...point(positions, 0).slice(0, 2));
    t.fill(() => 3, positions, normals);
    const after = Math.hypot(...point(positions, 0).slice(0, 2));
    expect(before).toBeCloseTo(1, 5);
    expect(after).toBeCloseTo(3, 5);
  });

  it('clamps a negative radius to zero rather than turning the tube inside out', () => {
    const mesh = buildTube(STRAIGHT, () => -2, white, { radialSegments: 6, step: 10 });
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(Math.hypot(point(mesh.positions, i)[0], point(mesh.positions, i)[1])).toBeCloseTo(0, 6);
    }
  });

  it('never produces NaN, even on a sharp kink', () => {
    const kinked = new Path([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 10, 10]]);
    const mesh = buildTube(kinked, () => 1, white, { radialSegments: 8, step: 0.5 });
    for (const arr of [mesh.positions, mesh.normals, mesh.colors]) {
      expect(arr.every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  it('colours vertices by distance along the path', () => {
    const mesh = buildTube(STRAIGHT, () => 1, (s) => [s / 50, 0, 0], { radialSegments: 4, step: 10 });
    expect(mesh.colors[0]).toBeCloseTo(0, 6);
    expect(mesh.colors[mesh.colors.length - 3]).toBeCloseTo(1, 6);
  });
});
