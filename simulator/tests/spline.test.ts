import { describe, expect, it } from 'vitest';
import { Path, catmullRom, sampleSpline, smoothPath } from '../src/anatomy/spline';
import { distance, length, type Vec3 } from '../src/anatomy/vec3';

const CONTROLS: Vec3[] = [
  [0, 0, 0],
  [10, 5, 0],
  [20, 0, 5],
  [30, -5, 0],
  [40, 0, 0],
];

describe('catmullRom', () => {
  it('starts at p1 and ends at p2', () => {
    const [p0, p1, p2, p3] = CONTROLS as [Vec3, Vec3, Vec3, Vec3];
    expect(distance(catmullRom(p0, p1, p2, p3, 0), p1)).toBeLessThan(1e-9);
    expect(distance(catmullRom(p0, p1, p2, p3, 1), p2)).toBeLessThan(1e-9);
  });
});

describe('sampleSpline', () => {
  it('passes through every control point', () => {
    const samples = sampleSpline(CONTROLS, 16);
    for (const c of CONTROLS) {
      const nearest = Math.min(...samples.map((s) => distance(s, c)));
      expect(nearest).toBeLessThan(1e-6);
    }
  });

  it('starts and ends at the first and last control point', () => {
    const samples = sampleSpline(CONTROLS, 16);
    expect(distance(samples[0]!, CONTROLS[0]!)).toBeLessThan(1e-9);
    expect(distance(samples[samples.length - 1]!, CONTROLS[CONTROLS.length - 1]!)).toBeLessThan(1e-9);
  });

  it('works with just two points (a straight line)', () => {
    const samples = sampleSpline([[0, 0, 0], [10, 0, 0]], 8);
    expect(samples.every((p) => Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9)).toBe(true);
  });

  it('rejects fewer than two points', () => {
    expect(() => sampleSpline([[0, 0, 0]])).toThrow();
  });

  it('is longer than the straight chord and shorter than the control polygon plus slack', () => {
    const path = smoothPath(CONTROLS);
    const chord = distance(CONTROLS[0]!, CONTROLS[4]!);
    let polygon = 0;
    for (let i = 1; i < CONTROLS.length; i++) polygon += distance(CONTROLS[i - 1]!, CONTROLS[i]!);
    expect(path.length).toBeGreaterThan(chord);
    expect(path.length).toBeLessThan(polygon * 1.05);
  });
});

describe('Path', () => {
  const line = new Path([[0, 0, 0], [10, 0, 0], [10, 10, 0]]);

  it('measures its length', () => {
    expect(line.length).toBeCloseTo(20, 9);
  });

  it('gives positions by distance, clamped at both ends', () => {
    expect(line.positionAt(5)).toEqual([5, 0, 0]);
    expect(line.positionAt(15)[1]).toBeCloseTo(5, 9);
    expect(line.positionAt(-3)).toEqual([0, 0, 0]);
    expect(line.positionAt(99)).toEqual([10, 10, 0]);
  });

  it('gives a unit tangent that follows the corner', () => {
    const before = line.tangentAt(5);
    const after = line.tangentAt(15);
    expect(before).toEqual([1, 0, 0]);
    expect(after).toEqual([0, 1, 0]);
    expect(length(line.tangentAt(10))).toBeCloseTo(1, 9);
  });

  it('reverses', () => {
    const r = line.reversed();
    expect(r.length).toBeCloseTo(20, 9);
    expect(r.positionAt(0)).toEqual([10, 10, 0]);
  });

  it('slices to the requested length', () => {
    const piece = line.slice(5, 15);
    expect(piece.length).toBeCloseTo(10, 9);
    expect(distance(piece.positionAt(0), line.positionAt(5))).toBeLessThan(1e-9);
    expect(distance(piece.positionAt(10), line.positionAt(15))).toBeLessThan(1e-9);
  });

  it('rejects a path of one point', () => {
    expect(() => new Path([[0, 0, 0]])).toThrow();
  });
});
