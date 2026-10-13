import { describe, expect, it } from 'vitest';
import { vesselPosition } from '../src/anatomy/centrelines';
import { LESION, VESSELS, VESSEL_ORDER } from '../src/config/anatomy';
import { treatmentsOf } from '../src/engine/simulation';
import { lumenDiameterAt, referenceDiameterAt } from '../src/physics/lesion';
import { MAX_OFF_VESSEL_MM, measureAtPoint, measurementLines } from '../src/scene/measure';
import { playGoodCase } from './helpers/player';

describe('measureAtPoint', () => {
  it('finds the vessel and the distance along it for a point on its centreline', () => {
    for (const [vessel, s] of [['LAD', 20], ['LAD', 48], ['LAD', 90], ['LCx', 40], ['D1', 20], ['D2', 25], ['RCA', 60]] as const) {
      const m = measureAtPoint(vesselPosition(vessel, s))!;
      expect(m.vessel).toBe(vessel);
      expect(Math.abs(m.s - s)).toBeLessThanOrEqual(0.5);
      expect(m.offMm).toBeLessThan(0.5);
    }
  });

  it('reads the pinch at the middle of the lesion and the healthy width just upstream', () => {
    const lesion = measureAtPoint(vesselPosition('LAD', LESION.centreS))!;
    expect(lesion.lumenMm).toBeCloseTo(0.297, 2);
    expect(lesion.stenosis).toBeGreaterThan(0.89);
    expect(lesion.referenceMm).toBeCloseTo(2.97, 1);
    const upstream = measureAtPoint(vesselPosition('LAD', 20))!;
    expect(upstream.lumenMm).toBeGreaterThan(3.3);
    expect(upstream.stenosis).toBe(0);
  });

  it('agrees with the lumen function the rules use, everywhere along the LAD', () => {
    for (let s = 2; s < 108; s += 4) {
      const m = measureAtPoint(vesselPosition('LAD', s))!;
      if (m.vessel !== 'LAD') continue; // a point right at a branch can belong to the branch
      expect(m.lumenMm).toBeCloseTo(lumenDiameterAt('LAD', m.s), 9);
      expect(m.referenceMm).toBeCloseTo(referenceDiameterAt('LAD', m.s), 9);
    }
  });

  it('shows the lumen opened by a stent', () => {
    const p = playGoodCase();
    const m = measureAtPoint(vesselPosition('LAD', LESION.centreS), treatmentsOf(p.sim))!;
    expect(m.lumenMm).toBeGreaterThan(2.5);
    expect(m.stenosis).toBeLessThan(0.15);
  });

  it('returns null for a point that is not near any vessel, and respects a tighter limit', () => {
    expect(measureAtPoint([300, 300, 300])).toBeNull();
    const near = vesselPosition('LAD', 30);
    const aside: [number, number, number] = [near[0] + 4, near[1], near[2]];
    expect(measureAtPoint(aside, [], 1)).toBeNull();
    expect(MAX_OFF_VESSEL_MM).toBeGreaterThanOrEqual(4);
  });

  it('can name every vessel', () => {
    for (const id of VESSEL_ORDER) {
      const mid = VESSELS[id].length / 2;
      const m = measureAtPoint(vesselPosition(id, mid))!;
      expect(m).not.toBeNull();
      expect(m.lumenMm).toBeGreaterThan(0);
    }
  });
});

describe('measurementLines', () => {
  it('words the pinch and the healthy segment', () => {
    const pinch = measurementLines(measureAtPoint(vesselPosition('LAD', LESION.centreS))!);
    expect(pinch[0]).toMatch(/^LAD, /);
    expect(pinch[1]).toMatch(/Lumen 0\.30 mm \(healthy 2\.9\d mm\)/);
    expect(pinch[2]).toMatch(/90% diameter stenosis/);
    const healthy = measurementLines(measureAtPoint(vesselPosition('LAD', 15))!);
    expect(healthy[2]).toBe('No narrowing here');
  });
});
