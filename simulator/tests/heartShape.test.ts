import { describe, expect, it } from 'vitest';
import {
  APEX_DIRECTION,
  BEAT_SHRINK,
  SYSTOLE_FRACTION,
  beatFactor,
  fatWeight,
  heartField,
  heartRadius,
  heartSurfacePoint,
  snapToHeart,
} from '../src/anatomy/heartShape';
import { distance, normalize, scale, type Vec3 } from '../src/anatomy/vec3';

const DIRECTIONS: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 1], [-1, 1, 0.5], [0.3, -0.9, 0.2], [-0.7, -0.2, -0.6],
];

describe('the heart surface', () => {
  it('has a sensible, finite size in every direction (a heart is about 9 to 14 cm across)', () => {
    for (const d of DIRECTIONS) {
      const r = heartRadius(d);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(25);
      expect(r).toBeLessThan(75);
    }
  });

  it('puts the field at exactly 1 on the surface, inside below and outside above', () => {
    for (const d of DIRECTIONS) {
      const surface = heartSurfacePoint(d);
      expect(heartField(surface)).toBeCloseTo(1, 4);
      expect(heartField(scale(surface, 0.9))).toBeLessThan(1);
      expect(heartField(scale(surface, 1.1))).toBeGreaterThan(1);
    }
  });

  it('points the apex left, forward and down', () => {
    expect(APEX_DIRECTION[0]).toBeGreaterThan(0.3);
    expect(APEX_DIRECTION[1]).toBeLessThan(-0.3);
    expect(APEX_DIRECTION[2]).toBeGreaterThan(0.3);
  });

  it('reaches further along the long axis than across it', () => {
    const along = heartRadius(APEX_DIRECTION);
    const across = heartRadius(normalize([0.7, 0.7, 0]));
    expect(along).toBeGreaterThan(across);
  });

  it('snaps a point onto the surface, and snapping again changes nothing', () => {
    const p: Vec3 = [12, -30, 40];
    const once = snapToHeart(p, 1);
    const twice = snapToHeart(once, 1);
    expect(distance(once, twice)).toBeLessThan(1e-6);
    expect(heartField(snapToHeart(p))).toBeCloseTo(1, 4);
  });

  it('lifts a snapped point outward by the requested amount', () => {
    const d: Vec3 = [0.2, 0.5, 0.8];
    const on = heartSurfacePoint(d, 0);
    const lifted = heartSurfacePoint(d, 2);
    expect(distance(on, lifted)).toBeCloseTo(2, 6);
  });
});

describe('epicardial fat', () => {
  it('stays between 0 and 1', () => {
    for (const d of DIRECTIONS) {
      const w = fatWeight(heartSurfacePoint(d));
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('is heavier in the groove between atria and ventricles than at the apex', () => {
    const apex = fatWeight(heartSurfacePoint(APEX_DIRECTION));
    let best = 0;
    for (let i = 0; i < 360; i += 10) {
      const a = (i * Math.PI) / 180;
      best = Math.max(best, fatWeight(heartSurfacePoint([Math.cos(a), 0.4, Math.sin(a)])));
    }
    expect(best).toBeGreaterThan(apex);
  });
});

describe('beatFactor', () => {
  it('is 1 when relaxed and smallest at the end of systole', () => {
    expect(beatFactor(0)).toBeCloseTo(1, 9);
    expect(beatFactor(SYSTOLE_FRACTION)).toBeCloseTo(1 - BEAT_SHRINK, 9);
  });

  it('never leaves the range and is continuous across the wrap', () => {
    for (let i = 0; i <= 200; i++) {
      const v = beatFactor(i / 200);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      expect(v).toBeGreaterThanOrEqual(1 - BEAT_SHRINK - 1e-12);
    }
    expect(Math.abs(beatFactor(0.999999) - beatFactor(0))).toBeLessThan(1e-6);
    expect(beatFactor(1.25)).toBeCloseTo(beatFactor(0.25), 9);
    expect(beatFactor(-0.75)).toBeCloseTo(beatFactor(0.25), 9);
  });

  it('squeezes faster than it relaxes', () => {
    const squeezeRate = (1 - beatFactor(SYSTOLE_FRACTION)) / SYSTOLE_FRACTION;
    const relaxRate = (1 - beatFactor(SYSTOLE_FRACTION)) / (1 - SYSTOLE_FRACTION);
    expect(squeezeRate).toBeGreaterThan(relaxRate);
  });
});
