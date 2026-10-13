import { describe, expect, it } from 'vitest';
import { LESION, LESION_END, LESION_START, VESSELS } from '../src/config/anatomy';
import {
  diameterStenosis,
  lesionReferenceDiameter,
  lesionWeight,
  lumenDiameterAt,
  referenceDiameterAt,
  untreatedDiameterAt,
  worstResidualStenosis,
  type Treatment,
} from '../src/physics/lesion';

const stent = (diameter: number, length = 18, centreS: number = LESION.centreS): Treatment => ({
  kind: 'stent', vessel: 'LAD', centreS, length, diameter,
});

describe('reference anatomy', () => {
  it('puts the LAD reference diameter at the lesion in the specified 2.9 to 3.0 mm range', () => {
    expect(lesionReferenceDiameter()).toBeGreaterThanOrEqual(2.9);
    expect(lesionReferenceDiameter()).toBeLessThanOrEqual(3.0);
  });

  it('puts the lesion between D1 and D2', () => {
    expect(LESION_START).toBeGreaterThan(VESSELS.D1.branchS);
    expect(LESION_END).toBeLessThan(VESSELS.D2.branchS);
  });

  it('tapers every vessel from its proximal to its distal diameter and clamps outside the vessel', () => {
    for (const spec of Object.values(VESSELS)) {
      expect(referenceDiameterAt(spec.id, 0)).toBeCloseTo(spec.diameterProximal);
      expect(referenceDiameterAt(spec.id, spec.length)).toBeCloseTo(spec.diameterDistal);
      expect(referenceDiameterAt(spec.id, -5)).toBeCloseTo(spec.diameterProximal);
      expect(referenceDiameterAt(spec.id, spec.length + 5)).toBeCloseTo(spec.diameterDistal);
    }
  });
});

describe('stenosis profile', () => {
  it('is 14 mm long with a 4 mm plateau', () => {
    expect(LESION.length).toBe(14);
    expect(LESION.plateau).toBe(4);
    expect(lesionWeight(LESION.centreS)).toBe(1);
    expect(lesionWeight(LESION.centreS - 2)).toBe(1);
    expect(lesionWeight(LESION.centreS + 2)).toBe(1);
    expect(lesionWeight(LESION_START)).toBe(0);
    expect(lesionWeight(LESION_END)).toBe(0);
    expect(lesionWeight(LESION_START - 5)).toBe(0);
    expect(lesionWeight(LESION_END + 5)).toBe(0);
  });

  it('is symmetric and falls monotonically from the plateau to each end', () => {
    let previous = 1;
    for (let d = 2; d <= 7; d += 0.25) {
      const w = lesionWeight(LESION.centreS + d);
      expect(w).toBeCloseTo(lesionWeight(LESION.centreS - d), 12);
      expect(w).toBeLessThanOrEqual(previous + 1e-12);
      previous = w;
    }
  });

  it('is exactly a cosine taper: half way down the taper is half the narrowing', () => {
    expect(lesionWeight(LESION.centreS + 4.5)).toBeCloseTo(0.5, 12);
  });

  it('gives a 90% diameter stenosis at the narrowest point and none outside the lesion', () => {
    const centre = untreatedDiameterAt('LAD', LESION.centreS);
    expect(diameterStenosis(centre, referenceDiameterAt('LAD', LESION.centreS))).toBeCloseTo(0.9, 10);
    expect(centre).toBeCloseTo(lesionReferenceDiameter() * 0.1, 10);
    expect(untreatedDiameterAt('LAD', 20)).toBeCloseTo(referenceDiameterAt('LAD', 20));
    expect(untreatedDiameterAt('LAD', 90)).toBeCloseTo(referenceDiameterAt('LAD', 90));
  });

  it('narrows only the lesion vessel', () => {
    for (const id of ['LM', 'LCx', 'D1', 'D2', 'RCA'] as const) {
      expect(untreatedDiameterAt(id, 5)).toBeCloseTo(referenceDiameterAt(id, 5));
    }
  });

  it('never reports a negative diameter stenosis', () => {
    expect(diameterStenosis(3.5, 3.0)).toBe(0);
    expect(diameterStenosis(3.0, 3.0)).toBe(0);
  });
});

describe('lumen after treatment', () => {
  const live = (diameter: number): Treatment => ({ kind: 'balloon-live', vessel: 'LAD', centreS: LESION.centreS, length: 15, diameter });
  const done = (diameter: number): Treatment => ({ kind: 'balloon-done', vessel: 'LAD', centreS: LESION.centreS, length: 15, diameter });

  it('stretches the vessel to the diameter of a live balloon', () => {
    expect(lumenDiameterAt('LAD', LESION.centreS, [live(2.5)])).toBeCloseTo(2.5);
  });

  it('leaves a plain balloon open minus about 30% elastic recoil', () => {
    expect(lumenDiameterAt('LAD', LESION.centreS, [done(2.575)])).toBeCloseTo(2.575 * 0.7);
    const residual = worstResidualStenosis([done(2.575)]);
    expect(residual).toBeGreaterThan(0.3);
    expect(residual).toBeLessThan(0.5);
  });

  it('holds a stent at its expanded size minus about 3% recoil, leaving almost no residual stenosis', () => {
    expect(lumenDiameterAt('LAD', LESION.centreS, [stent(3.072)])).toBeCloseTo(3.072 * 0.97);
    expect(worstResidualStenosis([stent(3.072)])).toBeLessThan(0.1);
  });

  it('leaves an untreated lesion at 90% residual', () => {
    expect(worstResidualStenosis([])).toBeCloseTo(0.9, 6);
  });

  it('ignores treatments on another vessel', () => {
    const other: Treatment = { kind: 'stent', vessel: 'LCx', centreS: 30, length: 18, diameter: 3 };
    expect(lumenDiameterAt('LAD', LESION.centreS, [other])).toBeCloseTo(untreatedDiameterAt('LAD', LESION.centreS));
  });

  it('never narrows the vessel anywhere', () => {
    for (const treatment of [live(2.0), done(2.0), stent(2.5)]) {
      for (let s = 0; s <= 110; s += 0.5) {
        expect(lumenDiameterAt('LAD', s, [treatment])).toBeGreaterThanOrEqual(untreatedDiameterAt('LAD', s) - 1e-12);
      }
    }
  });

  it('does not reach beyond the treated segment, and joins smoothly at its ends', () => {
    const segment = stent(3.072, 18);
    expect(lumenDiameterAt('LAD', LESION.centreS + 9.01, [segment])).toBeCloseTo(untreatedDiameterAt('LAD', LESION.centreS + 9.01));
    let previous = lumenDiameterAt('LAD', 30, [segment]);
    for (let s = 30.1; s <= 70; s += 0.1) {
      const here = lumenDiameterAt('LAD', s, [segment]);
      expect(Math.abs(here - previous)).toBeLessThan(0.35);
      previous = here;
    }
  });

  it('keeps the larger of overlapping treatments', () => {
    const both = lumenDiameterAt('LAD', LESION.centreS, [done(2.575), stent(3.072)]);
    expect(both).toBeCloseTo(3.072 * 0.97);
  });
});
