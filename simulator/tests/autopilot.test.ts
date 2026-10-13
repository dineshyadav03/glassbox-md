import { describe, expect, it } from 'vitest';
import { createSimulation, summarize, type Simulation } from '../src/engine/simulation';
import { GOOD_PLAN, advanceDemo, createPilot, pilotFinished, pilotStep, type DemoPlan } from '../src/demo/autopilot';
import { timiForVessel } from '../src/physics/flow';
import { flowSceneOf } from '../src/engine/simulation';
import { vitalsOf } from '../src/physics/physiology';

/** Run a demo to its end, a frame at a time, as the screen does. */
function runDemo(plan: DemoPlan = GOOD_PLAN, frame = 0.05, limitS = 600): { sim: Simulation; narration: string[]; steps: string[] } {
  let sim = createSimulation();
  let pilot = createPilot(plan);
  const steps: string[] = [];
  while (!pilotFinished(pilot, sim) && sim.time < limitS) {
    ({ sim, pilot } = advanceDemo(sim, pilot, frame));
    if (steps[steps.length - 1] !== pilot.step) steps.push(pilot.step);
  }
  const narration = sim.messages.filter((m) => m.text.startsWith('Demo: ')).map((m) => m.text);
  return { sim, narration, steps };
}

describe('the demo autopilot', () => {
  const demo = runDemo();

  it('completes all six steps and ends on an Excellent debrief', () => {
    expect(demo.sim.ended).toBe(true);
    expect(demo.sim.progress.completedAt.every((t) => t !== null)).toBe(true);
    expect(demo.sim.debrief!.grade).toBe('Excellent');
    expect(demo.sim.debrief!.score).toBe(100);
    expect(demo.sim.debrief!.cappedBy).toEqual([]);
  });

  it('does it the way the brief says: 2.5 x 15 balloon at 10 atm for about 12 s, then a 3.0 x 18 stent at 12 atm', () => {
    expect(demo.sim.balloon.spec).toMatchObject({ diameter: 2.5, length: 15 });
    const balloonRun = demo.sim.balloon.log[0]!;
    expect(balloonRun.peakAtm).toBeGreaterThanOrEqual(10);
    expect(balloonRun.peakAtm).toBeLessThan(11);
    expect(balloonRun.durationS).toBeGreaterThan(11);
    expect(balloonRun.durationS).toBeLessThan(20);
    const s = summarize(demo.sim);
    expect(s.stentsDeployed).toBe(1);
    expect(s.proximalMarginMm!).toBeGreaterThanOrEqual(1.5);
    expect(s.distalMarginMm!).toBeGreaterThanOrEqual(1.5);
    expect(s.finalTimi).toBe(3);
    expect(s.dissection).toBe('none');
  });

  it('keeps the patient stable, uses little dye and little radiation, and does not force the wire', () => {
    expect(vitalsOf(demo.sim.patient).unstable).toBe(false);
    expect(demo.sim.contrastMl).toBe(24);
    expect(demo.sim.fluoroSeconds / 60).toBeLessThan(1);
    expect(demo.sim.wire.forcingSeconds).toBe(0);
  });

  it('goes through every step in order, once each', () => {
    expect(demo.steps[0]).toBe('turn-to-left-cusp');
    // The case ends with the second final angiogram, so the pilot's last step is that run.
    expect(demo.steps[demo.steps.length - 1]).toBe('second-view-second-run');
    expect(new Set(demo.steps).size).toBe(demo.steps.length);
    expect(demo.steps).toHaveLength(24);
  });

  it('narrates each step once, in plain sentences, in the mentor log', () => {
    expect(demo.narration.length).toBeGreaterThanOrEqual(20);
    expect(new Set(demo.narration).size).toBe(demo.narration.length);
    for (const line of demo.narration) expect(line.length).toBeGreaterThan(20);
    expect(demo.narration.some((l) => /left coronary cusp/.test(l))).toBe(true);
    expect(demo.narration.some((l) => /never blind/.test(l))).toBe(true);
    expect(demo.narration.some((l) => /not getting blood/.test(l))).toBe(true);
  });

  it('finishes in a sensible time, under four minutes of case time', () => {
    expect(demo.sim.time).toBeGreaterThan(60);
    expect(demo.sim.time).toBeLessThan(240);
  });

  it('gives the same result whatever the frame length, as on a fast or a slow screen', () => {
    const slow = runDemo(GOOD_PLAN, 0.25);
    const fast = runDemo(GOOD_PLAN, 0.016);
    for (const other of [slow, fast]) {
      expect(other.sim.debrief!.grade).toBe('Excellent');
      expect(other.sim.debrief!.score).toBe(100);
      expect(summarize(other.sim).stentsDeployed).toBe(1);
    }
  });
});

describe('the autopilot as an input source', () => {
  it('only ever asks for the things a person can do: held controls and ordinary buttons', () => {
    let sim = createSimulation();
    let pilot = createPilot();
    const allowed = new Set(['narrate', 'select-tool', 'heparin', 'inject', 'measure', 'choose-size', 'cycle-carm']);
    const seen = new Set<string>();
    for (let i = 0; i < 6000 && !pilotFinished(pilot, sim); i++) {
      const out = pilotStep(pilot, sim, 0.05);
      for (const a of out.actions) seen.add(a.type);
      for (const value of Object.values(out.controls)) expect(['number', 'boolean']).toContain(typeof value);
      expect(Math.abs(out.controls.advance)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.controls.rotate)).toBeLessThanOrEqual(1);
      ({ sim, pilot } = advanceDemo(sim, pilot, 0.05));
    }
    for (const type of seen) expect(allowed.has(type)).toBe(true);
    expect(seen.has('heparin') && seen.has('measure') && seen.has('inject')).toBe(true);
  });

  it('does nothing once the case is over', () => {
    const { sim } = runDemo();
    const out = pilotStep(createPilot(), sim, 0.05);
    expect(out.actions).toEqual([]);
    expect(out.controls).toEqual({ advance: 0, rotate: 0, fine: false, inflate: false, deflate: false, fluoro: false });
  });

  it('is deterministic: the same case twice gives the same debrief and clock', () => {
    const a = runDemo();
    const b = runDemo();
    expect(a.sim.time).toBeCloseTo(b.sim.time, 9);
    expect(a.sim.debrief).toEqual(b.sim.debrief);
  });
});

describe('the same script playing a poor case (the specification\'s deliberately bad one)', () => {
  const bad = runDemo({ ...GOOD_PLAN, stent: { diameter: 4.0, length: 18, atm: 16 } });

  it('causes a dissection that the stent does not seal, and reduced flow', () => {
    expect(bad.sim.dissections.some((d) => d.cause === 'stent' && !d.sealed)).toBe(true);
    expect(timiForVessel(flowSceneOf(bad.sim), 'LAD')).toBeLessThan(3);
  });

  it('ends on a Needs work debrief', () => {
    expect(bad.sim.debrief!.grade).toBe('Needs work');
    expect(bad.sim.debrief!.cappedBy).toContain('unsealed dissection');
  });
});
