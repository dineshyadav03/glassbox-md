/**
 * End-to-end at the logic level: real catheters are inflated, their treatments change the lumen,
 * oversizing creates dissections, the flow model grades the result, and the debrief scores it.
 * Nothing here is hand-written except the choices a learner would make. This is the Phase 1
 * stand-in for the specification's "done when" cases; the demo run itself needs the UI (Phase 5).
 */
import { describe, expect, it } from 'vitest';
import { LESION } from '../src/config/anatomy';
import { edgeDissectionS, isOversized, makeDissection, refreshSealing, type Dissection } from '../src/physics/dissection';
import { distalFlowFactor, simulateFlow, timiForVessel, type FlowScene } from '../src/physics/flow';
import { lesionReferenceDiameter, worstResidualStenosis, type Treatment } from '../src/physics/lesion';
import { stepPhysiology, INITIAL_PHYSIOLOGY, vitalsOf } from '../src/physics/physiology';
import { buildDebrief, type ProcedureSummary } from '../src/procedure/evaluation';
import {
  createCatheter,
  lesionCoverage,
  longestInflationS,
  makeSpec,
  placeInPatient,
  postDilateStents,
  stepInflation,
  treatmentsFor,
  liveBalloonOf,
  type Catheter,
} from '../src/tools/devices';

const DT = 0.02;

function spec(kind: 'balloon' | 'stent', d: number, l: number) {
  const s = makeSpec(kind, d, l);
  if (!s) throw new Error('no such size');
  return s;
}

/** Inflate to a pressure, hold, deflate: what a learner does with E, a wait, and Q. */
function inflateHoldDeflate(start: Catheter, atm: number, holdS: number): Catheter {
  let c = start;
  let guard = 0;
  while (c.pressure < atm && guard++ < 5000) c = stepInflation(c, { inflate: true, deflate: false, fine: false }, DT).catheter;
  for (let t = 0; t < holdS; t += DT) c = stepInflation(c, { inflate: false, deflate: false, fine: false }, DT).catheter;
  guard = 0;
  while (c.pressure > 0 && guard++ < 5000) c = stepInflation(c, { inflate: false, deflate: true, fine: false }, DT).catheter;
  return c;
}

interface Choices {
  balloon?: { d: number; l: number; atm: number; holdS: number };
  stent: { d: number; l: number; atm: number };
  forcedWire?: boolean;
}

function treatCase(choices: Choices) {
  let balloon: Catheter | null = null;
  const dissections: Dissection[] = [];
  const reference = lesionReferenceDiameter();

  if (choices.balloon) {
    const b = choices.balloon;
    balloon = inflateHoldDeflate(placeInPatient(createCatheter(spec('balloon', b.d, b.l)), 'LAD', LESION.centreS), b.atm, b.holdS);
    const achieved = balloon.log[0]!.achievedDiameter;
    if (isOversized(achieved, reference)) {
      dissections.push(makeDissection('LAD', LESION.centreS + b.l / 2, 'balloon'));
    }
  }

  const s = choices.stent;
  const stent = inflateHoldDeflate(placeInPatient(createCatheter(spec('stent', s.d, s.l)), 'LAD', LESION.centreS), s.atm, 1);
  const stentTreatment = treatmentsFor(stent)[0] as Treatment;
  if (isOversized(stentTreatment.diameter, reference)) {
    dissections.push(makeDissection('LAD', edgeDissectionS(stentTreatment.centreS, stentTreatment.length), 'stent'));
  }
  if (choices.forcedWire) dissections.push(makeDissection('LAD', LESION.centreS, 'wire'));

  const treatments: Treatment[] = [...(balloon ? treatmentsFor(balloon) : []), stentTreatment];
  const sealed = refreshSealing(dissections, treatments);
  const scene: FlowScene = { treatments, dissections: sealed };
  const coverage = lesionCoverage(stentTreatment.centreS, stentTreatment.length);

  const dissection: ProcedureSummary['dissection'] = sealed.length === 0 ? 'none' : sealed.every((d) => d.sealed) ? 'sealed' : 'unsealed';
  const summary: ProcedureSummary = {
    completed: true,
    residualStenosis: worstResidualStenosis(treatments),
    finalTimi: timiForVessel(scene, 'LAD'),
    stentDiameterRatio: stentTreatment.diameter / reference,
    proximalMarginMm: coverage.proximalMarginMm,
    distalMarginMm: coverage.distalMarginMm,
    stentsDeployed: 1,
    heparin: 'before-wire',
    predilated: balloon !== null,
    qcaUsed: true,
    dissection,
    wireForcingSeconds: choices.forcedWire ? 4 : 0,
    balloonRuptures: balloon?.ruptured ? 1 : 0,
    longestInflationS: Math.max(balloon ? longestInflationS(balloon) : 0, longestInflationS(stent)),
    contrastMl: 56,
    fluoroSeconds: 300,
    finalViews: 2,
  };
  return { summary, scene, stentTreatment, dissections: sealed, debrief: buildDebrief(summary) };
}

describe('a well-judged case: 2.5 x 15 balloon at 10 atm, then a 3.0 x 18 stent at 12 atm', () => {
  const result = treatCase({ balloon: { d: 2.5, l: 15, atm: 10, holdS: 8 }, stent: { d: 3.0, l: 18, atm: 12 } });

  it('opens the artery fully, sizes the stent to the vessel and covers the lesion with margin', () => {
    expect(result.summary.residualStenosis!).toBeLessThan(0.1);
    expect(result.summary.stentDiameterRatio!).toBeGreaterThan(0.95);
    expect(result.summary.stentDiameterRatio!).toBeLessThan(1.15);
    expect(result.summary.proximalMarginMm!).toBeCloseTo(2);
    expect(result.summary.distalMarginMm!).toBeCloseTo(2);
    expect(result.dissections).toEqual([]);
  });

  it('restores TIMI 3 flow where the untreated lesion gave TIMI 2', () => {
    expect(timiForVessel({ treatments: [], dissections: [] }, 'LAD')).toBe(2);
    expect(result.summary.finalTimi).toBe(3);
    expect(distalFlowFactor(result.scene, 'LAD')).toBe(1);
  });

  it('is scored Excellent', () => {
    expect(result.debrief.grade).toBe('Excellent');
    expect(result.debrief.score).toBe(100);
    expect(result.debrief.cappedBy).toEqual([]);
  });
});

describe('a deliberately bad case: an oversized, short stent at high pressure', () => {
  const result = treatCase({ stent: { d: 4.0, l: 12, atm: 16 } });

  it('is oversized for the vessel, which tears the wall just beyond the stent, unsealed', () => {
    expect(result.summary.stentDiameterRatio!).toBeGreaterThan(1.2);
    expect(result.dissections).toHaveLength(1);
    expect(result.dissections[0]).toMatchObject({ vessel: 'LAD', cause: 'stent', sealed: false });
    expect(result.dissections[0]!.s).toBeGreaterThan(result.stentTreatment.centreS + result.stentTreatment.length / 2);
    expect(result.summary.dissection).toBe('unsealed');
  });

  it('reduces flow below that of the good case, to TIMI 2 and about 45% of normal', () => {
    expect(result.summary.finalTimi).toBe(2);
    expect(distalFlowFactor(result.scene, 'LAD')).toBeCloseTo(0.45);
    const slow = simulateFlow(result.scene).arrival.LAD;
    const good = simulateFlow({ treatments: [{ ...result.stentTreatment, length: 18, diameter: 3.072 }], dissections: [] }).arrival.LAD;
    expect(slow[slow.length - 1]!).toBeGreaterThan(good[good.length - 1]!);
  });

  it('is a geographic miss, because the stent is shorter than the lesion', () => {
    expect(result.summary.proximalMarginMm!).toBeLessThan(0);
    expect(result.summary.distalMarginMm!).toBeLessThan(0);
  });

  it('is scored Needs work, held down by the unsealed dissection and the geographic miss', () => {
    expect(result.debrief.grade).toBe('Needs work');
    expect(result.debrief.cappedBy).toEqual(['unsealed dissection', 'geographic miss']);
    expect(result.debrief.score).toBeLessThan(buildDebrief({ ...result.summary, dissection: 'none', finalTimi: 3 }).score);
  });
});

describe('mistakes a stent can put right', () => {
  it('seals a dissection from an oversized balloon when the stent covers it, costing only a warning', () => {
    const result = treatCase({ balloon: { d: 3.5, l: 15, atm: 16, holdS: 5 }, stent: { d: 3.0, l: 18, atm: 12 } });
    expect(result.dissections).toHaveLength(1);
    expect(result.dissections[0]!.cause).toBe('balloon');
    expect(result.dissections[0]!.sealed).toBe(true);
    expect(result.summary.dissection).toBe('sealed');
    expect(result.summary.finalTimi).toBe(3);
    expect(result.debrief.items.find((i) => i.id === 'dissection')!.status).toBe('warn');
    expect(result.debrief.cappedBy).toEqual([]);
  });

  it('seals a wire dissection in the lesion with a stent that covers the lesion', () => {
    const result = treatCase({ balloon: { d: 2.5, l: 15, atm: 10, holdS: 5 }, stent: { d: 3.0, l: 18, atm: 12 }, forcedWire: true });
    expect(result.dissections[0]).toMatchObject({ cause: 'wire', sealed: true });
    expect(result.summary.finalTimi).toBe(3);
  });

  it('leaves a wire dissection open, and flow reduced, if the stent misses it', () => {
    const result = treatCase({ stent: { d: 3.0, l: 12, atm: 12 }, forcedWire: true });
    // 12 mm stent centred on the lesion still covers its middle, so shift the dissection to the edge instead.
    const edge = makeDissection('LAD', 41.2, 'wire', [result.stentTreatment]);
    expect(edge.sealed).toBe(false);
    const scene: FlowScene = { treatments: [result.stentTreatment], dissections: [edge] };
    expect(timiForVessel(scene, 'LAD')).toBe(2);
  });
});

describe('post-dilating a stent', () => {
  it('a larger balloon inflated inside it enlarges it, and a smaller one does not', () => {
    const stented = treatCase({ stent: { d: 3.0, l: 18, atm: 12 } }).stentTreatment;
    let live: Catheter = placeInPatient(createCatheter(spec('balloon', 3.5, 12)), 'LAD', LESION.centreS);
    for (let i = 0; i < 400 && live.pressure < 12; i++) live = stepInflation(live, { inflate: true, deflate: false, fine: false }, DT).catheter;
    const dilated = postDilateStents([stented], liveBalloonOf(live));
    expect(dilated[0]!.diameter).toBeGreaterThan(stented.diameter);

    let small: Catheter = placeInPatient(createCatheter(spec('balloon', 2.5, 12)), 'LAD', LESION.centreS);
    for (let i = 0; i < 400 && small.pressure < 8; i++) small = stepInflation(small, { inflate: true, deflate: false, fine: false }, DT).catheter;
    expect(postDilateStents([stented], liveBalloonOf(small))[0]!.diameter).toBe(stented.diameter);
  });
});

describe('the patient through a balloon inflation', () => {
  it('becomes ischaemic while the balloon blocks the LAD and recovers once it is deflated', () => {
    let balloon: Catheter = placeInPatient(createCatheter(spec('balloon', 2.5, 15)), 'LAD', LESION.centreS);
    let patient = INITIAL_PHYSIOLOGY;
    const pump = { inflate: true, deflate: false, fine: false };
    const hold = { inflate: false, deflate: false, fine: false };
    const release = { inflate: false, deflate: true, fine: false };

    const tick = (input: typeof pump) => {
      balloon = stepInflation(balloon, input, 0.1).catheter;
      const scene: FlowScene = { treatments: treatmentsFor(balloon), dissections: [] };
      patient = stepPhysiology(patient, distalFlowFactor(scene, 'LAD'), 0.1);
    };

    for (let i = 0; i < 40; i++) tick(pump); // 4 s at 3 atm/s: up to about 12 atm, under the rated 14
    for (let i = 0; i < 150; i++) tick(hold); // held 15 s: the balloon is sealing the vessel
    expect(vitalsOf(patient).stMm).toBeGreaterThan(2);
    expect(vitalsOf(patient).unstable).toBe(false);

    for (let i = 0; i < 40; i++) tick(release);
    for (let i = 0; i < 300; i++) tick(hold);
    expect(vitalsOf(patient).stMm).toBeLessThan(0.1);
  });

  it('becomes unstable if the balloon is left up for over a minute', () => {
    let balloon: Catheter = placeInPatient(createCatheter(spec('balloon', 2.5, 15)), 'LAD', LESION.centreS);
    let patient = INITIAL_PHYSIOLOGY;
    for (let i = 0; i < 30; i++) balloon = stepInflation(balloon, { inflate: true, deflate: false, fine: false }, 0.1).catheter;
    for (let i = 0; i < 700; i++) {
      balloon = stepInflation(balloon, { inflate: false, deflate: false, fine: false }, 0.1).catheter;
      patient = stepPhysiology(patient, distalFlowFactor({ treatments: treatmentsFor(balloon), dissections: [] }, 'LAD'), 0.1);
    }
    expect(vitalsOf(patient).unstable).toBe(true);
    expect(vitalsOf(patient).message).toMatch(/Deflate now/);
  });
});
