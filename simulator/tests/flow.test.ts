import { describe, expect, it } from 'vitest';
import { CONTRAST, FLOW, LEFT_SYSTEM, LESION, VESSELS } from '../src/config/anatomy';
import {
  edgeDissectionS,
  isOversized,
  isSealed,
  makeDissection,
  refreshSealing,
  unsealed,
  type Dissection,
} from '../src/physics/dissection';
import {
  cineDurationSeconds,
  contrastVolumeMl,
  distalFlowFactor,
  flowFactor,
  ringPositions,
  simulateFlow,
  timiForVessel,
  timiGrade,
  type FlowScene,
} from '../src/physics/flow';
import type { Treatment } from '../src/physics/lesion';

const stent: Treatment = { kind: 'stent', vessel: 'LAD', centreS: LESION.centreS, length: 18, diameter: 3.072 };
const liveBalloon = (diameter: number): Treatment => ({ kind: 'balloon-live', vessel: 'LAD', centreS: LESION.centreS, length: 15, diameter });
const untreated: FlowScene = { treatments: [], dissections: [] };
const stented: FlowScene = { treatments: [stent], dissections: [] };

/** Seconds per mm over a stretch of one vessel, from the arrival times. */
function secondsPerMm(vessel: keyof typeof VESSELS, atS: number, scene: FlowScene): number {
  const positions = ringPositions(vessel);
  const i = positions.findIndex((s) => s >= atS);
  const arrival = simulateFlow(scene).arrival[vessel];
  return ((arrival[i + 1] ?? 0) - (arrival[i] ?? 0)) / ((positions[i + 1] ?? 0) - (positions[i] ?? 0));
}

describe('flowFactor', () => {
  it('is 1 below 60% and 0 at 98% and above', () => {
    for (const ds of [0, 0.2, 0.5, 0.59]) expect(flowFactor(ds)).toBe(1);
    for (const ds of [0.98, 0.99, 1, 1.2]) expect(flowFactor(ds)).toBe(0);
  });

  it('falls monotonically and steeply between', () => {
    let previous = 1;
    for (let ds = 0; ds <= 1.0001; ds += 0.005) {
      const f = flowFactor(ds);
      expect(f).toBeLessThanOrEqual(previous + 1e-12);
      expect(f).toBeGreaterThanOrEqual(0);
      previous = f;
    }
    expect(flowFactor(0.6) - flowFactor(0.9)).toBeGreaterThan(0.5);
  });

  it('puts a 90% stenosis at TIMI 2', () => {
    expect(flowFactor(0.9)).toBeGreaterThanOrEqual(0.25);
    expect(flowFactor(0.9)).toBeLessThan(0.8);
    expect(timiGrade(flowFactor(0.9))).toBe(2);
  });
});

describe('timiGrade', () => {
  it('applies the specified thresholds', () => {
    expect(timiGrade(1)).toBe(3);
    expect(timiGrade(0.8)).toBe(3);
    expect(timiGrade(0.79)).toBe(2);
    expect(timiGrade(0.25)).toBe(2);
    expect(timiGrade(0.249)).toBe(1);
    expect(timiGrade(0.021)).toBe(1);
    expect(timiGrade(0.02)).toBe(0);
    expect(timiGrade(0)).toBe(0);
  });

  it('is monotone in the flow factor', () => {
    let previous = 3;
    for (let f = 1; f >= 0; f -= 0.01) {
      const grade = timiGrade(f);
      expect(grade).toBeLessThanOrEqual(previous);
      previous = grade;
    }
  });
});

describe('contrast transit', () => {
  it('gives the untreated 90% lesion TIMI 2 and a stented one TIMI 3', () => {
    expect(timiForVessel(untreated, 'LAD')).toBe(2);
    expect(timiForVessel(stented, 'LAD')).toBe(3);
  });

  it('slows beyond the lesion, but not before it', () => {
    const before = secondsPerMm('LAD', 10, untreated);
    const beyond = secondsPerMm('LAD', 80, untreated);
    expect(before).toBeCloseTo(1 / FLOW.baseSpeed, 6);
    expect(beyond).toBeGreaterThan(before * 2);
    expect(beyond).toBeCloseTo(1 / (FLOW.baseSpeed * flowFactor(0.9)), 6);
  });

  it('inherits the limit into branches that leave beyond the lesion, not before it', () => {
    const d1 = simulateFlow(untreated).arrival.D1;
    const d1Healthy = simulateFlow(stented).arrival.D1;
    expect(d1).toEqual(d1Healthy);
    const d2 = simulateFlow(untreated).arrival.D2;
    const d2Healthy = simulateFlow(stented).arrival.D2;
    expect(d2[d2.length - 1]!).toBeGreaterThan(d2Healthy[d2Healthy.length - 1]!);
  });

  it('recovers after stenting: the far end fills sooner and the distal flow factor returns to 1', () => {
    const before = simulateFlow(untreated).arrival.LAD;
    const after = simulateFlow(stented).arrival.LAD;
    expect(after[after.length - 1]!).toBeLessThan(before[before.length - 1]!);
    expect(distalFlowFactor(stented, 'LAD')).toBe(1);
  });

  it('starts at time 0 in the left main and never runs backwards in any vessel', () => {
    for (const scene of [untreated, stented, { treatments: [liveBalloon(2.5)], dissections: [] }]) {
      const { arrival } = simulateFlow(scene);
      expect(arrival.LM[0]).toBe(0);
      for (const vessel of LEFT_SYSTEM) {
        const times = arrival[vessel];
        expect(times.length).toBe(ringPositions(vessel).length);
        for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
      }
    }
  });

  it('has rings from 0 to the vessel end with no duplicates', () => {
    for (const vessel of LEFT_SYSTEM) {
      const positions = ringPositions(vessel);
      expect(positions[0]).toBe(0);
      expect(positions[positions.length - 1]).toBe(VESSELS[vessel].length);
      expect(new Set(positions).size).toBe(positions.length);
    }
  });
});

describe('an inflated balloon', () => {
  const occluded: FlowScene = { treatments: [liveBalloon(2.5)], dissections: [] };
  const proximalEnd = LESION.centreS - 15 / 2;

  it('stops flow beyond it, including into D2, but not into D1 or the circumflex', () => {
    const { arrival } = simulateFlow(occluded);
    const lad = arrival.LAD;
    const positions = ringPositions('LAD');
    positions.forEach((s, i) => {
      if (s <= proximalEnd) expect(Number.isFinite(lad[i]!)).toBe(true);
      else expect(lad[i]!).toBe(Infinity);
    });
    expect(arrival.D2.every((t) => t === Infinity)).toBe(true);
    expect(arrival.D1.every((t) => Number.isFinite(t))).toBe(true);
    expect(arrival.LCx.every((t) => Number.isFinite(t))).toBe(true);
    expect(timiForVessel(occluded, 'LAD')).toBe(0);
    expect(distalFlowFactor(occluded, 'LAD')).toBe(0);
  });

  it('does not seal the vessel if it is too small for it', () => {
    const small: FlowScene = { treatments: [liveBalloon(2.0)], dissections: [] };
    const lad = simulateFlow(small).arrival.LAD;
    expect(Number.isFinite(lad[lad.length - 1]!)).toBe(true);
  });

  it('lets flow resume once it is deflated, with a plain balloon still giving TIMI 3', () => {
    const deflated: FlowScene = {
      treatments: [{ kind: 'balloon-done', vessel: 'LAD', centreS: LESION.centreS, length: 15, diameter: 2.575 }],
      dissections: [],
    };
    expect(timiForVessel(deflated, 'LAD')).toBe(3);
  });
});

describe('dissections', () => {
  const beyondStent: Dissection = { vessel: 'LAD', s: 62, cause: 'stent', sealed: false };

  it('multiplies downstream flow by about 0.45 when unsealed, and only downstream', () => {
    const scene: FlowScene = { treatments: [stent], dissections: [beyondStent] };
    const { factor } = simulateFlow(scene);
    const positions = ringPositions('LAD');
    positions.forEach((s, i) => {
      if (s < 62) expect(factor.LAD[i]).toBe(1);
      else expect(factor.LAD[i]).toBeCloseTo(FLOW.dissectionFactor);
    });
    expect(timiForVessel(scene, 'LAD')).toBe(2);
    expect(factor.D2[0]).toBeCloseTo(FLOW.dissectionFactor);
    expect(factor.D1.every((f) => f === 1)).toBe(true);
  });

  it('has no effect once sealed', () => {
    const scene: FlowScene = { treatments: [stent], dissections: [{ ...beyondStent, sealed: true }] };
    expect(timiForVessel(scene, 'LAD')).toBe(3);
  });

  it('seals when a stent covers it, as refreshSealing computes', () => {
    const inside = makeDissection('LAD', LESION.centreS, 'wire');
    expect(inside.sealed).toBe(false);
    expect(refreshSealing([inside], [stent])[0]!.sealed).toBe(true);
    expect(refreshSealing([inside], [])[0]!.sealed).toBe(false);
    const scene: FlowScene = { treatments: [stent], dissections: refreshSealing([inside], [stent]) };
    expect(timiForVessel(scene, 'LAD')).toBe(3);
  });

  it('slows an upstream dissection into every branch beyond it', () => {
    const early: Dissection = { vessel: 'LAD', s: 20, cause: 'wire', sealed: false };
    const { factor } = simulateFlow({ treatments: [stent], dissections: [early] });
    expect(factor.D1[0]).toBeCloseTo(FLOW.dissectionFactor);
    expect(factor.D2[0]).toBeCloseTo(FLOW.dissectionFactor);
    expect(factor.LCx.every((f) => f === 1)).toBe(true);
  });
});

describe('dissection rules', () => {
  it('seals only inside the working length of a deployed stent on the same vessel', () => {
    expect(isSealed('LAD', LESION.centreS + 9, [stent])).toBe(true);
    expect(isSealed('LAD', LESION.centreS + 9.01, [stent])).toBe(false);
    expect(isSealed('LCx', LESION.centreS, [stent])).toBe(false);
    expect(isSealed('LAD', LESION.centreS, [{ ...stent, kind: 'balloon-done' }])).toBe(false);
  });

  it('calls a device oversized only strictly above 1.2 times the reference', () => {
    expect(isOversized(3.6, 3.0)).toBe(false);
    expect(isOversized(3.61, 3.0)).toBe(true);
  });

  it('puts an oversized stent\'s edge dissection beyond its end, so the stent cannot seal it', () => {
    const s = edgeDissectionS(LESION.centreS, 12);
    expect(s).toBeCloseTo(LESION.centreS + 6 + 1.5);
    expect(isSealed('LAD', s, [{ ...stent, length: 12 }])).toBe(false);
  });

  it('lists the unsealed ones', () => {
    const a = makeDissection('LAD', 50, 'wire', [stent]);
    const b = makeDissection('LAD', 70, 'stent');
    expect(unsealed([a, b])).toEqual([b]);
  });
});

describe('cine and contrast', () => {
  it('lasts longer for slower filling, within limits, and ignores vessels that never fill', () => {
    const fast = cineDurationSeconds(simulateFlow(stented));
    const slow = cineDurationSeconds(simulateFlow(untreated));
    expect(slow).toBeGreaterThan(fast);
    for (const d of [fast, slow, cineDurationSeconds(simulateFlow({ treatments: [liveBalloon(2.5)], dissections: [] }))]) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(FLOW.minCineSeconds);
      expect(d).toBeLessThanOrEqual(FLOW.maxCineSeconds);
    }
  });

  it('uses 8 ml for a selective injection and 20 ml for an aortic flush', () => {
    expect(contrastVolumeMl(true)).toBe(CONTRAST.selectiveMl);
    expect(contrastVolumeMl(false)).toBe(CONTRAST.aorticMl);
    expect(CONTRAST.selectiveMl).toBe(8);
    expect(CONTRAST.aorticMl).toBe(20);
  });
});
