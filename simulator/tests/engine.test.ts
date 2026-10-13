import { describe, expect, it } from 'vitest';
import { AORTIC_ROOT_S, LESION } from '../src/config/anatomy';
import {
  NO_CONTROLS,
  act,
  availability,
  createSimulation,
  factsOf,
  flowSceneOf,
  stageIndexOf,
  summarize,
  tick,
  treatmentsOf,
} from '../src/engine/simulation';
import { timiForVessel } from '../src/physics/flow';
import { vitalsOf } from '../src/physics/physiology';
import { Player, playGoodCase } from './helpers/player';

describe('a new case', () => {
  const sim = createSimulation();

  it('starts at the wrist with the guide selected, on the first step, with a first hint', () => {
    expect(sim.tool).toBe('guide');
    expect(sim.guide.s).toBe(0);
    expect(stageIndexOf(sim)).toBe(0);
    expect(sim.messages[0]!.text).toMatch(/Advance the guide/);
    expect(sim.ended).toBe(false);
  });

  it('locks every tool the first step does not allow, with a reason', () => {
    expect(availability(sim, 'guide').available).toBe(true);
    for (const tool of ['wire', 'balloon', 'stent', 'measure', 'contrast'] as const) {
      const a = availability(sim, tool);
      expect(a.available).toBe(false);
      expect(a.reason!.length).toBeGreaterThan(10);
    }
  });

  it('says why when a locked tool is chosen, and keeps the current one', () => {
    const after = act(sim, { type: 'select-tool', tool: 'wire' });
    expect(after.tool).toBe('guide');
    expect(after.messages[after.messages.length - 1]!.text).toMatch(/Seat the guide/);
  });

  it('does not change when nothing is held', () => {
    const later = tick(sim, NO_CONTROLS, 1);
    expect(later.guide).toEqual(sim.guide);
    expect(later.patient.ischaemia).toBe(0);
  });
});

describe('step 1: the guide to the root', () => {
  it('advances along the route, and the rule rail and the checks agree', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 270);
    expect(p.facts().guidePastElbow).toBe(true);
    expect(p.facts().guideInAorta).toBe(false);
    expect(p.sim.guide.s).toBeGreaterThanOrEqual(270);
  });

  it('only counts the fluoroscopy sub-task if the pedal is used past the elbow', () => {
    const early = new Player().hold({ advance: 1, fluoro: true }, 1).until({ advance: 1 }, (s) => s.guide.s >= 300);
    expect(early.sim.progress.latched['s1.fluoro']).toBeFalsy();
    early.hold({ fluoro: true }, 0.2);
    expect(early.sim.progress.latched['s1.fluoro']).toBe(true);
  });

  it('stops at the aortic root and never goes beyond it', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01).hold({ advance: 1 }, 2);
    expect(p.sim.guide.s).toBeCloseTo(AORTIC_ROOT_S, 6);
  });

  it('is only counted fluoro time while the pedal is held', () => {
    const p = new Player().hold({ fluoro: true }, 2).hold({}, 5);
    expect(p.sim.fluoroSeconds).toBeCloseTo(2, 1);
  });
});

describe('step 2: engaging the left main', () => {
  const atRoot = () => new Player().hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01);

  it('seats with the tip facing the left cusp and a gentle push, then allows an angiogram', () => {
    const p = atRoot().until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20);
    expect(p.sim.guide.engaged).toBe(true);
    p.angiogram();
    expect(p.sim.latch.diagnostic).toBe(true);
    expect(p.sim.progress.completedAt[1]).not.toBeNull();
  });

  it('bounces off if pushed fast, and says so', () => {
    const p = atRoot().hold({ advance: 1 }, 1);
    expect(p.sim.guide.engaged).toBe(false);
    expect(p.sim.messages.some((m) => /gently/.test(m.text))).toBe(true);
  });

  it('does not seat with the tip facing the wrong cusp, and names the cusp', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01).hold({ advance: 1, fine: true }, 3);
    expect(p.sim.guide.engaged).toBe(false);
    expect(p.sim.messages.some((m) => /not facing a coronary cusp|right coronary cusp|non-coronary/.test(m.text))).toBe(true);
  });

  it('pops out if over-rotated once seated', () => {
    const p = atRoot().until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).hold({ rotate: 1 }, 1);
    expect(p.sim.guide.engaged).toBe(false);
    expect(p.sim.messages.some((m) => /popped out/.test(m.text))).toBe(true);
  });

  it('records contrast without fluoroscopy as wasted: no angiogram, but the dye is spent', () => {
    const p = atRoot().until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).do({ type: 'inject' });
    expect(p.sim.latch.diagnostic).toBe(false);
    expect(p.sim.contrastMl).toBe(8);
    expect(p.lastMessage()).toMatch(/without fluoroscopy/);
  });

  it('uses more dye and shows nothing selective for an aortic flush before the guide is seated', () => {
    const p = new Player().until({ advance: 1 }, (s) => s.guide.s >= 725).hold({ fluoro: true }, 0.1).do({ type: 'inject' });
    expect(p.sim.contrastMl).toBe(20);
    expect(p.sim.injection!.selective).toBe(false);
    expect(p.sim.latch.diagnostic).toBe(false);
  });

  it('refuses a second injection while a run is in progress', () => {
    const p = atRoot().until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).hold({ fluoro: true }, 0.1).do({ type: 'inject' }).do({ type: 'inject' });
    expect(p.sim.contrastMl).toBe(8);
  });
});

describe('step 3: heparin and the wire', () => {
  const seated = () => {
    const p = new Player().hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01);
    return p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram();
  };

  it('keeps the wire locked until heparin is given', () => {
    const p = seated();
    expect(availability(p.sim, 'wire').reason).toMatch(/heparin/i);
    p.do({ type: 'heparin' });
    expect(availability(p.sim, 'wire').available).toBe(true);
    expect(p.sim.heparin).toBe('before-wire');
  });

  it('gives heparin once only', () => {
    const p = seated().do({ type: 'heparin' }).do({ type: 'heparin' });
    expect(p.lastMessage()).toMatch(/already/);
  });

  it('enters the circumflex if the tip is left neutral at the bifurcation', () => {
    const p = seated().do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' }).until({ advance: 1 }, (s) => s.wire.vessel !== 'LM' && s.wire.vessel !== null);
    expect(p.sim.wire.vessel).toBe('LCx');
  });

  it('enters the LAD when the tip is turned toward it first, and crosses slowly without harm', () => {
    const p = seated().do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' }).hold({ rotate: -1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30).hold({ rotate: 1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.s >= 78, 60);
    expect(p.sim.wire.dissected).toBe(false);
    expect(p.sim.wire.forcingSeconds).toBe(0);
    expect(p.sim.progress.completedAt[2]).not.toBeNull();
    expect(p.sim.dissections).toEqual([]);
  });

  it('forcing the wire builds risk, and a bad roll makes a dissection that slows the flow', () => {
    const p = new Player(() => 0);
    p.hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram();
    p.do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' }).hold({ rotate: -1 }, 0.5);
    p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30).hold({ rotate: 1 }, 0.5);
    p.until({ advance: 1 }, (s) => s.wire.s >= 78, 30);
    expect(p.sim.wire.forcingSeconds).toBeGreaterThan(0.5);
    expect(p.sim.dissections).toHaveLength(1);
    expect(p.sim.dissections[0]).toMatchObject({ vessel: 'LAD', cause: 'wire', sealed: false });
    // The tear's 0.45 on top of the lesion's own 0.45 is slower than the untreated lesion alone (TIMI 2).
    expect(timiForVessel(flowSceneOf(p.sim), 'LAD')).toBe(1);
  });

  it('cannot move the guide while the wire is out', () => {
    const p = seated().do({ type: 'heparin' }).do({ type: 'select-tool', tool: 'wire' }).until({ advance: 1 }, (s) => s.wire.outOfGuide);
    const at = p.sim.guide.s;
    p.do({ type: 'select-tool', tool: 'guide' }).hold({ advance: -1 }, 1);
    expect(p.sim.guide.s).toBe(at);
    expect(p.sim.messages.some((m) => /cannot move while the wire is out/.test(m.text))).toBe(true);
  });
});

describe('the whole case, played carefully', () => {
  const p = playGoodCase();

  it('completes all six steps, in order, and ends', () => {
    expect(p.sim.ended).toBe(true);
    expect(p.sim.progress.completedAt.every((t) => t !== null)).toBe(true);
    const times = p.sim.progress.completedAt as number[];
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!);
  });

  it('leaves one stent that is the right size, covers the lesion with margin and opens the artery', () => {
    const s = summarize(p.sim);
    expect(s.stentsDeployed).toBe(1);
    expect(s.stentDiameterRatio!).toBeGreaterThan(0.95);
    expect(s.stentDiameterRatio!).toBeLessThan(1.15);
    expect(s.proximalMarginMm!).toBeGreaterThanOrEqual(1.5);
    expect(s.distalMarginMm!).toBeGreaterThanOrEqual(1.5);
    expect(s.residualStenosis!).toBeLessThan(0.1);
    expect(s.finalTimi).toBe(3);
    expect(s.dissection).toBe('none');
  });

  it('is scored Excellent', () => {
    expect(p.sim.debrief!.grade).toBe('Excellent');
    expect(p.sim.debrief!.score).toBe(100);
  });

  it('kept the patient stable throughout, and well at the end', () => {
    expect(vitalsOf(p.sim.patient).unstable).toBe(false);
    expect(vitalsOf(p.sim.patient).stMm).toBeLessThan(1);
  });

  it('used a modest amount of dye and fluoroscopy', () => {
    expect(p.sim.contrastMl).toBe(24);
    expect(p.sim.fluoroSeconds / 60).toBeLessThan(2);
  });

  it('ignores further input once the case has ended', () => {
    const after = tick(p.sim, { ...NO_CONTROLS, advance: 1 }, 1);
    expect(after).toBe(p.sim);
    expect(act(p.sim, { type: 'heparin' })).toBe(p.sim);
  });

  it('keeps the stent in the artery after its delivery catheter is withdrawn', () => {
    expect(p.sim.stent.inGuide).toBe(true);
    expect(treatmentsOf(p.sim).filter((t) => t.kind === 'stent')).toHaveLength(1);
    expect(factsOf(p.sim).stentDeployedAndDeflated).toBe(true);
  });
});

describe('the stage locks along the way', () => {
  const stopped = () => playGoodCase({ stopAfterWire: true });

  it('keeps the stent locked until the lesion is pre-dilated', () => {
    expect(availability(stopped().sim, 'stent').reason).toMatch(/Pre-dilate/);
  });

  it('allows the balloon once the wire is parked beyond the lesion', () => {
    expect(availability(stopped().sim, 'balloon').available).toBe(true);
  });

  it('will not advance a balloon over a wire that is not in the LAD', () => {
    const p = new Player();
    p.hold({ rotate: 1 }, 1).until({ advance: 1 }, (s) => s.guide.s >= AORTIC_ROOT_S - 0.01);
    p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20).angiogram().do({ type: 'heparin' });
    p.do({ type: 'select-tool', tool: 'wire' }).until({ advance: 1 }, (s) => s.wire.outOfGuide);
    // The balloon tool itself is still locked: the wire has not crossed the lesion.
    expect(availability(p.sim, 'balloon').reason).toMatch(/Cross the lesion/);
  });

  it('keeps the balloon behind the wire tip', () => {
    const p = stopped().do({ type: 'select-tool', tool: 'balloon' }).hold({ advance: 1 }, 20);
    const tip = p.sim.wire.s + 12;
    expect(p.sim.balloon.centreS! + 15 / 2 + 12).toBeLessThanOrEqual(tip);
  });

  it('will not move or withdraw a catheter while it is inflated', () => {
    const p = stopped().do({ type: 'select-tool', tool: 'balloon' }).until({ advance: 1 }, (s) => factsOf(s).balloonAcrossLesion, 30);
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 4, 10);
    const at = p.sim.balloon.centreS;
    p.hold({ advance: -1 }, 1);
    expect(p.sim.balloon.centreS).toBe(at);
    expect(p.lastMessage()).toMatch(/Deflate it/);
  });

  it('will not inflate inside the guide', () => {
    const p = stopped().do({ type: 'select-tool', tool: 'balloon' }).hold({ inflate: true }, 1);
    expect(p.sim.balloon.pressure).toBe(0);
    expect(p.lastMessage()).toMatch(/out of the guide/);
  });
});

describe('mistakes show up in the debrief', () => {
  it('no heparin: the wire stays locked, so the case cannot proceed without it', () => {
    expect(() => playGoodCase({ noHeparin: true })).toThrow();
  });

  it('forcing the wire at full speed (with a bad roll) is flagged, and a stent that covers it seals it', () => {
    const p = playGoodCase({ forceWire: true }, () => 0);
    const s = summarize(p.sim);
    expect(s.wireForcingSeconds).toBeGreaterThan(0.5);
    expect(s.dissection).toBe('sealed');
    expect(p.sim.debrief!.items.find((i) => i.id === 'forcing')!.status).not.toBe('ok');
    expect(p.sim.debrief!.items.find((i) => i.id === 'dissection')!.status).toBe('warn');
  });

  it('an oversized stent tears the wall beyond it, unsealed, and caps the grade', () => {
    const p = playGoodCase({ stent: { diameter: 4.0, length: 18, atm: 16 } });
    const s = summarize(p.sim);
    expect(s.dissection).toBe('unsealed');
    expect(p.sim.debrief!.grade).toBe('Needs work');
    expect(p.sim.debrief!.cappedBy).toContain('unsealed dissection');
  });

  it('an oversized balloon tears the wall, which the stent then seals', () => {
    const p = playGoodCase({ balloon: { diameter: 3.5, length: 15, atm: 12, holdS: 4 } });
    expect(p.sim.dissections.some((d) => d.cause === 'balloon')).toBe(true);
    expect(summarize(p.sim).dissection).toBe('sealed');
  });

  it('one final projection is a warning, not a failure', () => {
    const p = new Player();
    const full = playGoodCase({ oneFinalView: true });
    expect(full.sim.ended).toBe(false);
    expect(factsOf(full.sim).distinctProjectionsAfterStent).toBe(1);
    expect(p.sim.ended).toBe(false);
  });

  it('a short stent leaves step 5 open (covering the lesion is required), and the miss is scored if the case is ended', () => {
    const p = playGoodCase({ stent: { diameter: 3.0, length: 12, atm: 12 } });
    expect(p.sim.ended).toBe(false);
    expect(p.sim.progress.latched['s5.cover']).toBeFalsy();
    const s = summarize(p.sim);
    expect(s.proximalMarginMm!).toBeLessThan(0);
    expect(s.distalMarginMm!).toBeLessThan(0);
    p.do({ type: 'end-case' });
    expect(p.sim.debrief!.grade).toBe('Incomplete');
    expect(p.sim.debrief!.items.find((i) => i.id === 'coverage')!.value).toMatch(/geographic miss/);
  });

  it('ending the case early gives an incomplete debrief', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'end-case' });
    expect(p.sim.ended).toBe(true);
    expect(p.sim.debrief!.grade).toBe('Incomplete');
  });
});

describe('the deliberately bad case (an oversized stent at high pressure)', () => {
  const p = playGoodCase({ stent: { diameter: 4.0, length: 12, atm: 16 }, balloon: { diameter: 2.5, length: 15, atm: 10, holdS: 8 } });
  // A 12 mm stent cannot cover the lesion, so the case stays open; end it to see the debrief the learner would get.
  const ended = p.do({ type: 'end-case' }).sim;

  it('tears the wall just beyond the stent, and the tear is not sealed', () => {
    expect(ended.dissections).toHaveLength(1);
    expect(ended.dissections[0]).toMatchObject({ vessel: 'LAD', cause: 'stent', sealed: false });
  });

  it('leaves the flow reduced rather than normal', () => {
    expect(timiForVessel(flowSceneOf(ended), 'LAD')).toBeLessThan(3);
  });

  it('is graded Needs-work-or-worse, held down by the tear', () => {
    expect(['Needs work', 'Incomplete']).toContain(ended.debrief!.grade);
    expect(ended.debrief!.cappedBy).toContain('unsealed dissection');
  });

  it('with a long enough oversized stent the case finishes and is graded Needs work', () => {
    const full = playGoodCase({ stent: { diameter: 4.0, length: 18, atm: 16 } });
    expect(full.sim.ended).toBe(true);
    expect(timiForVessel(flowSceneOf(full.sim), 'LAD')).toBeLessThan(3);
    expect(full.sim.dissections.some((d) => !d.sealed)).toBe(true);
    expect(full.sim.debrief!.grade).toBe('Needs work');
  });
});

describe('the demo narration action', () => {
  it('adds a Demo-prefixed mentor message and changes nothing else', () => {
    const before = createSimulation();
    const after = act(before, { type: 'narrate', text: 'Advancing the guide.' });
    expect(after.messages[after.messages.length - 1]!.text).toBe('Demo: Advancing the guide.');
    expect({ ...after, messages: before.messages }).toEqual(before);
  });
});

describe('the patient and the balloon', () => {
  it('becomes ischaemic while an inflated balloon seals the LAD, and recovers after', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => factsOf(s).balloonAcrossLesion, 30);
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 10, 20).wait(15);
    expect(vitalsOf(p.sim.patient).stMm).toBeGreaterThan(1);
    expect(vitalsOf(p.sim.patient).unstable).toBe(false);
    p.until({ deflate: true }, (s) => s.balloon.pressure < 1, 20).wait(40);
    expect(vitalsOf(p.sim.patient).stMm).toBeLessThan(0.2);
  });

  it('becomes unstable if the balloon is left up for over a minute, and the mentor says so', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => factsOf(s).balloonAcrossLesion, 30);
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 10, 20).wait(70);
    expect(vitalsOf(p.sim.patient).unstable).toBe(true);
    expect(p.sim.messages.some((m) => /unstable/.test(m.text))).toBe(true);
  });

  it('ruptures a balloon taken far past its rating, and the debrief notes it', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => factsOf(s).balloonAcrossLesion, 30);
    p.until({ inflate: true }, (s) => s.balloon.ruptured, 20);
    expect(p.sim.balloonRuptures).toBe(1);
    expect(p.sim.dissections.some((d) => d.cause === 'rupture')).toBe(true);
    p.until({ advance: -1 }, (s) => s.balloon.inGuide, 60);
    expect(p.sim.balloon.ruptured).toBe(false);
    expect(summarize(p.sim).balloonRuptures).toBe(1);
  });
});

describe('measuring and sizing', () => {
  it('reads the reference diameter and lesion length off the angiogram', () => {
    const p = playGoodCase({ stopAfterWire: true });
    expect(p.sim.qca!.referenceDiameterMm).toBeCloseTo(2.97, 2);
    expect(p.sim.qca!.lesionLengthMm).toBe(LESION.length);
    expect(Math.round(p.sim.qca!.stenosis * 100)).toBe(90);
  });

  it('refuses a size that is not stocked, and keeps the old one', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'choose-size', kind: 'balloon', diameter: 9, length: 15 });
    expect(p.sim.balloon.spec.diameter).toBe(2.5);
    expect(p.lastMessage()).toMatch(/stocked/);
  });

  it('will not change size while the catheter is out of the guide', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' }).hold({ advance: 1 }, 1);
    p.do({ type: 'choose-size', kind: 'balloon', diameter: 3.0, length: 15 });
    expect(p.sim.balloon.spec.diameter).toBe(2.5);
    expect(p.lastMessage()).toMatch(/Withdraw the catheter/);
  });
});

describe('the C-arm angles', () => {
  it('starts at the first preset, and a preset sets the angles', () => {
    let sim = createSimulation();
    expect(sim.carmAngles).toEqual({ laoDeg: -30, cranialDeg: 30 });
    sim = act(sim, { type: 'select-carm', index: 2 });
    expect(sim.carmAngles).toEqual({ laoDeg: 45, cranialDeg: 30 });
    expect(sim.carm).toBe(2);
    expect(act(sim, { type: 'select-carm', index: 99 })).toBe(sim);
  });

  it('can be nudged freely and stops at its limits', () => {
    let sim = act(createSimulation(), { type: 'adjust-carm', laoDeg: 7, cranialDeg: -4 });
    expect(sim.carmAngles).toEqual({ laoDeg: -23, cranialDeg: 26 });
    sim = act(sim, { type: 'adjust-carm', laoDeg: 500, cranialDeg: 500 });
    expect(sim.carmAngles).toEqual({ laoDeg: 90, cranialDeg: 45 });
    sim = act(sim, { type: 'adjust-carm', laoDeg: -500, cranialDeg: -500 });
    expect(sim.carmAngles).toEqual({ laoDeg: -90, cranialDeg: -45 });
  });

  it('cycling presets after a nudge goes to the next preset, not a mixture', () => {
    const sim = act(act(createSimulation(), { type: 'adjust-carm', laoDeg: 11, cranialDeg: 0 }), { type: 'cycle-carm', direction: 1 });
    expect(sim.carmAngles).toEqual({ laoDeg: 0, cranialDeg: 35 });
  });

  it('counts a final projection only if the beam differs by at least 20 degrees from one already used', () => {
    const p = playGoodCase({ oneFinalView: true });
    expect(p.sim.finalProjections).toHaveLength(1);
    // Nudge by 10 degrees: a second angiogram from nearly the same view does not count as a second projection.
    p.do({ type: 'adjust-carm', laoDeg: 10, cranialDeg: 0 }).angiogram();
    expect(p.sim.ended).toBe(false);
    expect(p.sim.finalProjections).toHaveLength(1);
    // Nudge a further 15 (25 degrees from the first): now it counts and the case ends.
    p.do({ type: 'adjust-carm', laoDeg: 15, cranialDeg: 0 }).angiogram();
    expect(p.sim.finalProjections).toHaveLength(2);
    expect(p.sim.ended).toBe(true);
  });
});

describe('the C-arm', () => {
  it('cycles through the presets in both directions and wraps', () => {
    let sim = createSimulation();
    sim = act(sim, { type: 'cycle-carm', direction: -1 });
    expect(sim.carm).toBeGreaterThan(0);
    sim = act(sim, { type: 'cycle-carm', direction: 1 });
    expect(sim.carm).toBe(0);
  });
});
