import { describe, expect, it } from 'vitest';
import { CARM_PRESETS } from '../src/config/anatomy';
import { beamDirection, carmLabel, makeCamera, project, viewBasis, viewSeparationDeg } from '../src/xray/projection';
import { dot, length, type Vec3 } from '../src/anatomy/vec3';

const AP = { laoDeg: 0, cranialDeg: 0 };

describe('beam and image axes', () => {
  it('points the AP beam from back to front, with the patient\'s left on the right of the image and the head at the top', () => {
    const b = viewBasis(AP);
    expect(b.beam[2]).toBeCloseTo(1, 9);
    expect(b.right[0]).toBeCloseTo(1, 9);
    expect(b.up[1]).toBeCloseTo(1, 9);
  });

  it('swings the beam toward the patient\'s left for LAO and right for RAO', () => {
    expect(beamDirection({ laoDeg: 45, cranialDeg: 0 })[0]).toBeGreaterThan(0.6);
    expect(beamDirection({ laoDeg: -30, cranialDeg: 0 })[0]).toBeLessThan(-0.4);
  });

  it('tilts the beam toward the head for cranial and the feet for caudal', () => {
    expect(beamDirection({ laoDeg: 0, cranialDeg: 30 })[1]).toBeGreaterThan(0.45);
    expect(beamDirection({ laoDeg: 0, cranialDeg: -30 })[1]).toBeLessThan(-0.45);
  });

  it('always gives three perpendicular unit vectors, for every preset and a grid of angles', () => {
    const angles = [...CARM_PRESETS, ...[-90, -45, 0, 45, 90].flatMap((lao) => [-45, 0, 45].map((cranialDeg) => ({ laoDeg: lao, cranialDeg })))];
    for (const a of angles) {
      const b = viewBasis(a);
      for (const v of [b.beam, b.right, b.up]) expect(length(v)).toBeCloseTo(1, 9);
      expect(dot(b.beam, b.right)).toBeCloseTo(0, 9);
      expect(dot(b.beam, b.up)).toBeCloseTo(0, 9);
      expect(dot(b.right, b.up)).toBeCloseTo(0, 9);
    }
  });
});

describe('project', () => {
  const camera = makeCamera(AP, [0, 0, 0], 200, 400);

  it('puts the centre in the middle of the image and scales at pixels per mm', () => {
    expect(camera.pxPerMm).toBe(2);
    const c = project(camera, [0, 0, 0]);
    expect(c.x).toBeCloseTo(200, 9);
    expect(c.y).toBeCloseTo(200, 9);
    const p = project(camera, [10, 20, 5]);
    expect(p.x).toBeCloseTo(220, 9);
    expect(p.y).toBeCloseTo(160, 9);
  });

  it('ignores depth along the beam in the picture, but reports it', () => {
    const near = project(camera, [10, 20, 50]);
    const far = project(camera, [10, 20, -50]);
    expect(near.x).toBeCloseTo(far.x, 9);
    expect(near.y).toBeCloseTo(far.y, 9);
    expect(near.depth).toBeGreaterThan(far.depth);
  });

  it('shortens an object seen end-on (foreshortening)', () => {
    // A 50 mm rod running along z is seen end-on from AP, and full length from a lateral-ish 90 degree LAO.
    const rod: [Vec3, Vec3] = [[0, 0, -25], [0, 0, 25]];
    const length2d = (angles: typeof AP): number => {
      const cam = makeCamera(angles, [0, 0, 0], 200, 400);
      const a = project(cam, rod[0]);
      const b = project(cam, rod[1]);
      return Math.hypot(a.x - b.x, a.y - b.y) / cam.pxPerMm;
    };
    expect(length2d(AP)).toBeLessThan(1);
    expect(length2d({ laoDeg: 90, cranialDeg: 0 })).toBeCloseTo(50, 6);
    expect(length2d({ laoDeg: 45, cranialDeg: 0 })).toBeCloseTo(50 * Math.sin(Math.PI / 4), 6);
  });

  it('moves a point to the right in the image as the patient\'s left, in AP', () => {
    expect(project(camera, [30, 0, 0]).x).toBeGreaterThan(project(camera, [-30, 0, 0]).x);
    expect(project(camera, [0, 30, 0]).y).toBeLessThan(project(camera, [0, -30, 0]).y);
  });
});

describe('viewSeparationDeg', () => {
  it('is 0 for the same view, symmetric, and grows with the angle between them', () => {
    expect(viewSeparationDeg(AP, AP)).toBeCloseTo(0, 6);
    const a = { laoDeg: 45, cranialDeg: 30 };
    expect(viewSeparationDeg(AP, a)).toBeCloseTo(viewSeparationDeg(a, AP), 9);
    expect(viewSeparationDeg(AP, { laoDeg: 30, cranialDeg: 0 })).toBeCloseTo(30, 6);
    expect(viewSeparationDeg(AP, { laoDeg: 0, cranialDeg: 25 })).toBeCloseTo(25, 6);
    expect(viewSeparationDeg(AP, { laoDeg: 90, cranialDeg: 0 })).toBeCloseTo(90, 6);
  });

  it('treats the stock projections as different from each other where a cardiologist would', () => {
    const first = CARM_PRESETS[0]!;
    const second = CARM_PRESETS[2]!;
    expect(viewSeparationDeg(first, second)).toBeGreaterThan(20);
  });
});

describe('carmLabel', () => {
  it('uses the preset wording when the angles match a preset', () => {
    for (const p of CARM_PRESETS) expect(carmLabel(p)).toBe(p.label);
  });

  it('names other positions by side and tilt', () => {
    expect(carmLabel({ laoDeg: 37, cranialDeg: 12 })).toBe('LAO 37 CRA 12');
    expect(carmLabel({ laoDeg: -12, cranialDeg: -3 })).toBe('RAO 12 CAU 3');
    expect(carmLabel({ laoDeg: 20, cranialDeg: 0 })).toBe('LAO 20');
    expect(carmLabel({ laoDeg: 0, cranialDeg: 7 })).toBe('AP CRA 7');
    expect(carmLabel({ laoDeg: 0.2, cranialDeg: -0.3 })).toBe('AP');
  });
});
