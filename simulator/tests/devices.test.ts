import { describe, expect, it } from 'vitest';
import { BALLOON, INFLATION, LESION, LESION_END, LESION_START, STENT, VESSELS, pathOffsetOf } from '../src/config/anatomy';
import {
  acrossLesion,
  chooseSize,
  createCatheter,
  inflatedDiameter,
  isInflated,
  lesionCoverage,
  liveBalloonOf,
  loadFresh,
  longestInflationS,
  makeSpec,
  moveCatheter,
  placeInPatient,
  postDilateStents,
  stepInflation,
  treatmentsFor,
  withdrawToGuide,
  type Catheter,
  type InflationEvent,
  type InflationInput,
} from '../src/tools/devices';
import type { Treatment } from '../src/physics/lesion';

const IDLE: InflationInput = { inflate: false, deflate: false, fine: false };
const PUMP: InflationInput = { inflate: true, deflate: false, fine: false };
const FINE: InflationInput = { inflate: true, deflate: false, fine: true };
const RELEASE: InflationInput = { inflate: false, deflate: true, fine: false };

function spec(kind: 'balloon' | 'stent', d: number, l: number) {
  const s = makeSpec(kind, d, l);
  if (!s) throw new Error(`no such ${kind} ${d} x ${l}`);
  return s;
}

/** Hold an input for `seconds` in small steps, collecting events. */
function hold(start: Catheter, input: InflationInput, seconds: number, dt = 0.05) {
  let catheter = start;
  const events: InflationEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const out = stepInflation(catheter, input, dt);
    catheter = out.catheter;
    events.push(...out.events);
  }
  return { catheter, events };
}

/** A catheter out of the guide in the LAD, centred on the lesion. */
function atLesion(kind: 'balloon' | 'stent', d: number, l: number): Catheter {
  return placeInPatient(createCatheter(spec(kind, d, l)), 'LAD', LESION.centreS);
}

describe('sizes and the pressure-diameter curve', () => {
  it('stocks exactly the specified balloon and stent sizes', () => {
    expect(BALLOON.diameters).toEqual([2.0, 2.5, 3.0, 3.5]);
    expect(BALLOON.lengths).toEqual([12, 15, 20]);
    expect(STENT.diameters).toEqual([2.5, 2.75, 3.0, 3.5, 4.0]);
    expect(STENT.lengths).toEqual([12, 15, 18, 23, 28]);
    for (const d of BALLOON.diameters) for (const l of BALLOON.lengths) expect(makeSpec('balloon', d, l)).not.toBeNull();
    for (const d of STENT.diameters) for (const l of STENT.lengths) expect(makeSpec('stent', d, l)).not.toBeNull();
    expect(makeSpec('balloon', 2.75, 15)).toBeNull();
    expect(makeSpec('stent', 3.0, 20)).toBeNull();
  });

  it('gives a balloon nominal 8 atm, rated burst 14, rupture at 18; a stent 10, 16 and 20', () => {
    const b = spec('balloon', 2.5, 15);
    expect([b.nominalAtm, b.ratedBurstAtm, b.ruptureAtm]).toEqual([8, 14, 18]);
    const s = spec('stent', 3.0, 18);
    expect([s.nominalAtm, s.ratedBurstAtm, s.ruptureAtm]).toEqual([10, 16, 20]);
  });

  it('is nominal at nominal pressure', () => {
    expect(inflatedDiameter(spec('balloon', 2.5, 15), 8)).toBeCloseTo(2.5);
    expect(inflatedDiameter(spec('stent', 3.0, 18), 10)).toBeCloseTo(3.0);
  });

  it('follows nominal * (1 + c (P - nominal)): 1.5% per atm for a balloon, 1.2% for a stent', () => {
    expect(inflatedDiameter(spec('balloon', 2.5, 15), 10)).toBeCloseTo(2.5 * (1 + 0.015 * 2));
    expect(inflatedDiameter(spec('balloon', 3.0, 15), 14)).toBeCloseTo(3.0 * (1 + 0.015 * 6));
    expect(inflatedDiameter(spec('stent', 3.0, 18), 12)).toBeCloseTo(3.072);
    expect(inflatedDiameter(spec('stent', 4.0, 12), 16)).toBeCloseTo(4.0 * (1 + 0.012 * 6));
  });

  it('is smaller than the curve while unfolding below 2 atm, and continuous at 2 atm', () => {
    const b = spec('balloon', 2.5, 15);
    const at2 = inflatedDiameter(b, INFLATION.unfoldAtm);
    expect(inflatedDiameter(b, 0)).toBeCloseTo(INFLATION.foldedDiameter);
    expect(inflatedDiameter(b, 1)).toBeGreaterThan(INFLATION.foldedDiameter);
    expect(inflatedDiameter(b, 1)).toBeLessThan(at2);
    expect(inflatedDiameter(b, 1.999999)).toBeCloseTo(at2, 4);
    expect(inflatedDiameter(b, -3)).toBeCloseTo(INFLATION.foldedDiameter);
  });

  it('grows strictly with pressure, for every size, from 0 to the rupture pressure', () => {
    for (const kind of ['balloon', 'stent'] as const) {
      const table = kind === 'balloon' ? BALLOON : STENT;
      for (const d of table.diameters) {
        const s = spec(kind, d, table.lengths[0]);
        let previous = -Infinity;
        for (let p = 0; p <= s.ruptureAtm; p += 0.25) {
          const here = inflatedDiameter(s, p);
          expect(here).toBeGreaterThan(previous);
          previous = here;
        }
      }
    }
  });
});

describe('choosing a size', () => {
  it('works while the catheter is in the guide', () => {
    const c = createCatheter(spec('balloon', 2.0, 12));
    const out = chooseSize(c, 3.0, 20);
    expect(out.ok && out.value.spec.diameter).toBe(3.0);
    expect(out.ok && out.value.spec.length).toBe(20);
  });

  it('is locked once the catheter is out of the guide', () => {
    const out = chooseSize(atLesion('balloon', 2.5, 15), 3.0, 15);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/guide/);
  });

  it('is available again after withdrawing into the guide', () => {
    const withdrawn = withdrawToGuide(atLesion('balloon', 2.5, 15));
    expect(withdrawn.ok).toBe(true);
    const out = withdrawn.ok ? chooseSize(withdrawn.value, 3.5, 12) : null;
    expect(out?.ok).toBe(true);
  });

  it('rejects an unstocked size and a spent catheter', () => {
    const c = createCatheter(spec('stent', 3.0, 18));
    expect(chooseSize(c, 3.2, 18).ok).toBe(false);
    expect(chooseSize({ ...c, ruptured: true }, 3.0, 12).ok).toBe(false);
    expect(chooseSize({ ...c, deployed: true }, 3.0, 12).ok).toBe(false);
  });
});

describe('moving', () => {
  it('cannot move while inflated, and says to deflate', () => {
    const inflated = hold(atLesion('balloon', 2.5, 15), PUMP, 2).catheter;
    expect(isInflated(inflated)).toBe(true);
    const out = moveCatheter(inflated, 3);
    expect(out.catheter.centreS).toBe(LESION.centreS);
    expect(out.blocked).toMatch(/Deflate/);
    expect(withdrawToGuide(inflated).ok).toBe(false);
  });

  it('moves freely once deflated', () => {
    const inflated = hold(atLesion('balloon', 2.5, 15), PUMP, 2).catheter;
    const deflated = hold(inflated, RELEASE, 2).catheter;
    expect(moveCatheter(deflated, 3).catheter.centreS).toBeCloseTo(LESION.centreS + 3);
  });

  it('cannot move inside the guide', () => {
    const out = moveCatheter(createCatheter(spec('balloon', 2.5, 15)), 3);
    expect(out.blocked).toMatch(/out of the guide/);
  });

  it('stays behind the wire tip', () => {
    const c = atLesion('balloon', 2.5, 15);
    const tip = pathOffsetOf('LAD') + 60; // wire tip at s = 60 on the LAD
    const out = moveCatheter(c, 40, tip);
    expect(out.blocked).toMatch(/behind the wire/);
    expect(out.catheter.centreS! + 15 / 2).toBeLessThanOrEqual(60 - 1 + 1e-9);
    expect(moveCatheter(c, 1, tip).blocked).toBeNull();
  });

  it('stays inside the vessel', () => {
    const c = atLesion('balloon', 2.5, 15);
    expect(moveCatheter(c, 500).catheter.centreS).toBeCloseTo(VESSELS.LAD.length - 7.5);
    expect(moveCatheter(c, -500).catheter.centreS).toBeCloseTo(7.5);
  });
});

describe('inflating and deflating', () => {
  it('rises at about 3 atm/s, 0.5 atm/s with fine control, and falls faster', () => {
    const start = atLesion('balloon', 2.5, 15);
    expect(hold(start, PUMP, 2).catheter.pressure).toBeCloseTo(6, 6);
    expect(hold(start, FINE, 4).catheter.pressure).toBeCloseTo(2, 6);
    const up = hold(start, PUMP, 3).catheter;
    expect(hold(up, RELEASE, 1).catheter.pressure).toBeCloseTo(9 - 6, 6);
    expect(hold(up, RELEASE, 5).catheter.pressure).toBe(0);
  });

  it('cannot be inflated while in the guide', () => {
    const out = stepInflation(createCatheter(spec('balloon', 2.5, 15)), PUMP, 0.5);
    expect(out.catheter.pressure).toBe(0);
    expect(out.events).toEqual([{ type: 'inflate-in-guide' }]);
  });

  it('warns once above the rated burst pressure, before it ruptures', () => {
    const { catheter, events } = hold(atLesion('balloon', 2.5, 15), PUMP, 5.2); // to ~15.6 atm
    expect(catheter.pressure).toBeGreaterThan(14);
    expect(catheter.ruptured).toBe(false);
    expect(events.filter((e) => e.type === 'over-rated')).toHaveLength(1);
  });

  it('ruptures above the rated burst pressure plus 4, and is then spent', () => {
    const { catheter, events } = hold(atLesion('balloon', 2.5, 15), PUMP, 7);
    expect(catheter.ruptured).toBe(true);
    expect(catheter.pressure).toBe(0);
    expect(events.filter((e) => e.type === 'rupture')).toHaveLength(1);
    const rupture = events.find((e) => e.type === 'rupture');
    expect(rupture && rupture.type === 'rupture' && rupture.pressureAtm).toBeGreaterThan(18);
    expect(catheter.log).toHaveLength(1);
    expect(catheter.log[0]).toMatchObject({ ruptured: true, overRated: true });
    const again = stepInflation(catheter, PUMP, 1);
    expect(again.catheter.pressure).toBe(0);
    expect(again.events).toEqual([{ type: 'spent' }]);
  });

  it('does not rupture at exactly the rupture pressure', () => {
    const s = spec('balloon', 2.5, 15);
    const out = stepInflation({ ...atLesion('balloon', 2.5, 15), pressure: s.ruptureAtm - 0.1 }, PUMP, 0.03);
    expect(out.catheter.ruptured).toBe(false);
  });

  it('a fresh catheter can be loaded after a rupture', () => {
    const ruptured = hold(atLesion('balloon', 2.5, 15), PUMP, 7).catheter;
    const fresh = loadFresh(ruptured);
    expect(fresh).toMatchObject({ ruptured: false, pressure: 0, inGuide: true, log: [] });
    expect(fresh.spec).toEqual(ruptured.spec);
  });
});

describe('the inflation record', () => {
  it('logs peak pressure, duration, position and achieved diameter for one inflation', () => {
    const inflated = hold(atLesion('balloon', 2.5, 15), PUMP, 3.4).catheter; // ~10.2 atm
    const held = hold(inflated, IDLE, 12).catheter;
    const done = hold(held, RELEASE, 3).catheter;
    expect(done.log).toHaveLength(1);
    const record = done.log[0]!;
    expect(record.peakAtm).toBeGreaterThan(10);
    expect(record.vessel).toBe('LAD');
    expect(record.centreS).toBe(LESION.centreS);
    // 12 s held, plus about 3.1 s climbing from 1 atm to 10.2 and about 1.5 s falling back to 1.
    expect(record.durationS).toBeGreaterThan(16);
    expect(record.durationS).toBeLessThan(17.2);
    expect(record.achievedDiameter).toBeCloseTo(inflatedDiameter(done.spec, record.peakAtm));
    expect(record).toMatchObject({ overRated: false, ruptured: false });
    expect(done.current).toBeNull();
  });

  it('logs each inflation separately and finds the longest', () => {
    let c = atLesion('balloon', 2.5, 15);
    c = hold(hold(c, PUMP, 3).catheter, RELEASE, 3).catheter; // short
    c = hold(hold(hold(c, PUMP, 3).catheter, IDLE, 20).catheter, RELEASE, 3).catheter; // long
    expect(c.log).toHaveLength(2);
    expect(c.log[1]!.durationS).toBeGreaterThan(c.log[0]!.durationS);
    expect(longestInflationS(c)).toBe(c.log[1]!.durationS);
  });

  it('counts an inflation still in progress', () => {
    expect(longestInflationS(hold(atLesion('balloon', 2.5, 15), PUMP, 3).catheter)).toBeGreaterThan(1.5);
    expect(longestInflationS(atLesion('balloon', 2.5, 15))).toBe(0);
  });

  it('does not log a touch below the inflated pressure', () => {
    const touched = hold(hold(atLesion('balloon', 2.5, 15), FINE, 1).catheter, RELEASE, 2).catheter;
    expect(touched.log).toHaveLength(0);
  });
});

describe('stent deployment', () => {
  it('becomes deployed (permanent) once the pressure reaches 6 atm, announced once', () => {
    const low = hold(atLesion('stent', 3.0, 18), PUMP, 1.9); // ~5.7 atm
    expect(low.catheter.deployed).toBe(false);
    const high = hold(low.catheter, PUMP, 0.5);
    expect(high.catheter.deployed).toBe(true);
    expect(high.events.filter((e) => e.type === 'deployed')).toHaveLength(1);
    expect(high.catheter.deployedAt).toEqual({ vessel: 'LAD', centreS: LESION.centreS });
    const more = hold(high.catheter, PUMP, 1);
    expect(more.events.filter((e) => e.type === 'deployed')).toHaveLength(0);
  });

  it('is sized by its pressure, and only ever grows', () => {
    const at12 = hold(atLesion('stent', 3.0, 18), PUMP, 4).catheter; // ~12 atm
    expect(at12.deployedDiameter).toBeCloseTo(inflatedDiameter(at12.spec, at12.pressure));
    const deflated = hold(at12, RELEASE, 3).catheter;
    expect(deflated.deployedDiameter).toBeCloseTo(at12.deployedDiameter!);
    expect(deflated.deployed).toBe(true);
    const again = hold(deflated, PUMP, 5).catheter; // re-inflate higher: post-dilates itself
    expect(again.deployedDiameter!).toBeGreaterThan(at12.deployedDiameter!);
  });

  it('yields a permanent stent treatment at the deployment position, with no balloon marks', () => {
    const deployed = hold(hold(atLesion('stent', 3.0, 18), PUMP, 4).catheter, RELEASE, 3).catheter;
    const treatments = treatmentsFor(deployed);
    expect(treatments).toHaveLength(1);
    expect(treatments[0]).toMatchObject({ kind: 'stent', vessel: 'LAD', centreS: LESION.centreS, length: 18 });
    const moved = moveCatheter(deployed, 10).catheter;
    expect(treatmentsFor(moved)[0]!.centreS).toBe(LESION.centreS);
  });

  it('allows a fresh stent to be loaded after the first is deployed (bailout)', () => {
    const deployed = hold(hold(atLesion('stent', 3.0, 18), PUMP, 4).catheter, RELEASE, 3).catheter;
    const fresh = loadFresh(deployed);
    expect(fresh.deployed).toBe(false);
    expect(fresh.inGuide).toBe(true);
    expect(chooseSize(fresh, 3.5, 12).ok).toBe(true);
  });

  it('never deploys a balloon, and never deploys inside the guide', () => {
    expect(hold(atLesion('balloon', 2.5, 15), PUMP, 3).catheter.deployed).toBe(false);
    expect(stepInflation(createCatheter(spec('stent', 3.0, 18)), PUMP, 5).catheter.deployed).toBe(false);
  });
});

describe('treatments from a balloon', () => {
  it('shows a live balloon while inflated, then a done balloon at the peak diameter once deflated', () => {
    const inflated = hold(atLesion('balloon', 2.5, 15), PUMP, 3.4).catheter;
    const live = treatmentsFor(inflated);
    expect(live.map((t) => t.kind)).toEqual(['balloon-live']);
    expect(live[0]!.diameter).toBeCloseTo(inflatedDiameter(inflated.spec, inflated.pressure));
    expect(liveBalloonOf(inflated)).not.toBeNull();

    const done = hold(inflated, RELEASE, 3).catheter;
    const after = treatmentsFor(done);
    expect(after.map((t) => t.kind)).toEqual(['balloon-done']);
    expect(after[0]!.diameter).toBeCloseTo(done.log[0]!.achievedDiameter);
    expect(liveBalloonOf(done)).toBeNull();
  });

  it('has no treatment before any inflation or while still in the guide', () => {
    expect(treatmentsFor(atLesion('balloon', 2.5, 15))).toEqual([]);
    expect(treatmentsFor(createCatheter(spec('balloon', 2.5, 15)))).toEqual([]);
  });
});

describe('post-dilation', () => {
  const stent: Treatment = { kind: 'stent', vessel: 'LAD', centreS: 48, length: 18, diameter: 3.0 };
  const balloon = (diameter: number, centreS = 48): Treatment => ({ kind: 'balloon-live', vessel: 'LAD', centreS, length: 12, diameter });

  it('enlarges a stent under a larger balloon, never shrinks it', () => {
    expect(postDilateStents([stent], balloon(3.4))[0]!.diameter).toBe(3.4);
    expect(postDilateStents([stent], balloon(2.5))[0]!.diameter).toBe(3.0);
  });

  it('leaves a stent the balloon does not overlap, or another vessel, alone', () => {
    expect(postDilateStents([stent], balloon(3.4, 100))[0]!.diameter).toBe(3.0);
    expect(postDilateStents([stent], { ...balloon(3.4), vessel: 'LCx' })[0]!.diameter).toBe(3.0);
  });

  it('is a no-op without a balloon and does not mutate its input', () => {
    expect(postDilateStents([stent], null)).toEqual([stent]);
    postDilateStents([stent], balloon(3.9));
    expect(stent.diameter).toBe(3.0);
  });
});

describe('coverage of the lesion', () => {
  it('measures the margins at each end', () => {
    const c = lesionCoverage(LESION.centreS, 18);
    expect(c.proximalMarginMm).toBeCloseTo(2);
    expect(c.distalMarginMm).toBeCloseTo(2);
    expect(c.coversLesion).toBe(true);
    expect(c.overlapFraction).toBe(1);
  });

  it('calls a stent shorter than the lesion a geographic miss, with negative margins', () => {
    const c = lesionCoverage(LESION.centreS, 12);
    expect(c.proximalMarginMm).toBeCloseTo(-1);
    expect(c.distalMarginMm).toBeCloseTo(-1);
    expect(c.coversLesion).toBe(false);
    expect(c.overlapFraction).toBeCloseTo(12 / 14);
  });

  it('shows a displaced stent as covering one end only', () => {
    const c = lesionCoverage(LESION.centreS + 5, 18);
    expect(c.proximalMarginMm).toBeLessThan(0);
    expect(c.distalMarginMm).toBeGreaterThan(0);
    expect(c.coversLesion).toBe(false);
  });

  it('reports no overlap for a device away from the lesion', () => {
    expect(lesionCoverage(100, 12).overlapFraction).toBe(0);
    expect(lesionCoverage(LESION_START - 20, 12).overlapFraction).toBe(0);
    expect(lesionCoverage(LESION_END + 20, 12).coversLesion).toBe(false);
  });

  it('counts a balloon as across the lesion when it overlaps at least 80% and spans the middle', () => {
    expect(acrossLesion(LESION.centreS, 15)).toBe(true);
    expect(acrossLesion(LESION.centreS, 12)).toBe(true); // 12/14 = 86%
    expect(acrossLesion(LESION.centreS + 6, 12)).toBe(false); // overlap too small
    expect(acrossLesion(LESION.centreS - 30, 12)).toBe(false);
  });
});
