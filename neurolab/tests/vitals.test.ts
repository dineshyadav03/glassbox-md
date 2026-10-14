import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/rules';
import { cardiacPhase, ecgSampleMv } from '../src/physics/ecg';
import { alarmFor, baselineVitals, lossFraction, stepVitals } from '../src/physics/vitals';
import { act, bleedRate, initialField, isObstructed, tick, type Action, type FieldState, type Target } from '../src/procedure/field';
import { notesFor } from '../src/procedure/mentor';
import type { ToolId } from '../src/tools/tools';

const NONE: Target = { kind: 'none' };
const ICA: Target = { kind: 'vessel', id: 'ica' };
const DOME: Target = { kind: 'aneurysm', part: 'dome' };
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const use = (tool: ToolId, target: Target): Action => ({ type: 'click', tool, target });
const hold = (tool: ToolId, target: Target, dt: number): Action => ({ type: 'hold', tool, target, dt });

function run(state: FieldState, ...actions: Action[]): FieldState {
  return actions.reduce((s, a) => act(s, a).state, state);
}
/** Let `seconds` pass in small steps (as the frame loop does). */
function wait(state: FieldState, seconds: number, step = 0.25): FieldState {
  let s = state;
  for (let t = 0; t < seconds - 1e-9; t += step) s = tick(s, Math.min(step, seconds - t));
  return s;
}
const ruptured = (): FieldState => run(initialField(), use('scissors', DOME));
const openedAndFree = (): FieldState =>
  run(
    initialField(),
    ...RULES.arachnoidOrder.map((id) => use('scissors', { kind: 'arachnoid', id })),
    use('spatula', NONE),
    use('dissector', NECK),
    use('dissector', NECK),
    use('dissector', NECK),
  );

describe('the ECG', () => {
  it('has one tall R wave a beat, at the right place, and returns to baseline', () => {
    const samples = Array.from({ length: 200 }, (_, i) => ecgSampleMv(i / 200));
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(0.8);
    expect(samples.indexOf(peak) / 200).toBeCloseTo(0.21, 1);
    expect(Math.abs(ecgSampleMv(0.97))).toBeLessThan(0.02);
  });

  it('turns time and rate into a phase between 0 and 1', () => {
    expect(cardiacPhase(0, 60)).toBe(0);
    expect(cardiacPhase(0.5, 60)).toBeCloseTo(0.5, 9);
    expect(cardiacPhase(1.25, 60)).toBeCloseTo(0.25, 9);
    expect(cardiacPhase(10, 120)).toBeCloseTo(0, 9);
  });
});

describe('the vital signs', () => {
  it('start at baseline and stay there with no blood loss', () => {
    let v = baselineVitals();
    for (let i = 0; i < 100; i++) v = stepVitals(v, 0, false, 0, 1);
    expect(v.hr).toBeCloseTo(RULES.vitals.hr, 6);
    expect(v.sbp).toBeCloseTo(RULES.vitals.sbp, 6);
    expect(v.mep).toBe(100);
  });

  it('move toward a faster pulse and lower pressure and oxygen as blood is lost, and stay in range', () => {
    let v = baselineVitals();
    for (let i = 0; i < 300; i++) v = stepVitals(v, RULES.vitals.hypovolaemiaMl, false, 0, 1);
    expect(v.hr).toBeGreaterThan(RULES.vitals.hr + 40);
    expect(v.sbp).toBeLessThan(RULES.vitals.sbp - 40);
    expect(v.dbp).toBeLessThan(RULES.vitals.dbp);
    expect(v.spo2).toBeLessThan(RULES.vitals.spo2);
    expect(v.spo2).toBeGreaterThan(80);
    expect(lossFraction(1e9)).toBe(1);
    expect(lossFraction(-5)).toBe(0);
  });

  it('lag behind the loss rather than jumping', () => {
    const v = stepVitals(baselineVitals(), RULES.vitals.hypovolaemiaMl, false, 0, 1);
    expect(v.hr).toBeGreaterThan(RULES.vitals.hr);
    expect(v.hr).toBeLessThan(RULES.vitals.hr + RULES.vitals.hrRise / 2);
  });

  it('lower the MEP only after the grace time on the temporary clip, and recover once it is off', () => {
    let v = baselineVitals();
    for (let t = 0; t < RULES.vitals.mepGraceSeconds; t++) v = stepVitals(v, 0, true, t, 1);
    expect(v.mep).toBe(100);
    for (let t = 0; t < 60; t++) v = stepVitals(v, 0, true, RULES.vitals.mepGraceSeconds + t + 1, 1);
    expect(v.mep).toBeLessThan(100 - 10);
    const low = v.mep;
    expect(v.mepMin).toBe(low);
    for (let t = 0; t < 20; t++) v = stepVitals(v, 0, false, 0, 1);
    expect(v.mep).toBeGreaterThan(low);
    expect(v.mepMin).toBe(low);
    expect(v.mep).toBeLessThanOrEqual(100);
  });

  it('raise an alarm for each line crossed, worst first, and none at baseline', () => {
    const base = baselineVitals();
    expect(alarmFor(base)).toBeNull();
    expect(alarmFor({ ...base, sbp: 80 })?.text).toBe('Low blood pressure');
    expect(alarmFor({ ...base, spo2: 90 })?.text).toBe('Low oxygen saturation');
    expect(alarmFor({ ...base, mep: 70 })?.text).toContain('evoked');
    expect(alarmFor({ ...base, hr: 140 })?.text).toBe('Fast heart rate');
    expect(alarmFor({ ...base, sbp: 80, spo2: 90 })?.text).toBe('Low blood pressure');
  });
});

describe('bleeding', () => {
  it('has none in the quiet field and a little from a small ooze', () => {
    expect(bleedRate(initialField())).toBe(0);
    const ooze = run(openedAndFree());
    expect(ooze.oozes).toHaveLength(1);
    expect(bleedRate(ooze)).toBeCloseTo(RULES.bleedOozeMlPerSecond, 9);
  });

  it('is brisk from a cut artery and stops when bipolar seals it', () => {
    const cut = run(initialField(), use('scissors', ICA));
    expect(bleedRate(cut)).toBeCloseTo(RULES.bleedBriskMlPerSecond, 9);
    const sealed = run(cut, hold('bipolar', { kind: 'ooze', id: cut.oozes[0]!.id }, RULES.briskCoagulateSeconds + 0.1));
    expect(bleedRate(sealed)).toBe(0);
  });

  it('is fast from a rupture, slowed by a temporary clip, and stopped by the clip', () => {
    const burst = ruptured();
    expect(bleedRate(burst)).toBeCloseTo(RULES.bleedRuptureMlPerSecond, 9);
    const clamped = run(burst, use('tempClip', ICA));
    expect(bleedRate(clamped)).toBeCloseTo(RULES.bleedRuptureMlPerSecond * RULES.tempClipBleedFactor, 9);
    expect(bleedRate({ ...burst, clip: { variant: 'straight', angleDeg: 0, depth: 0.8, appliedAt: 0 } })).toBe(0);
  });

  it('adds up the blood lost and pools it, up to the pool limit', () => {
    const s = wait(ruptured(), 2);
    expect(s.ebl).toBeCloseTo(2 * RULES.bleedRuptureMlPerSecond, 6);
    expect(s.pooled).toBeCloseTo(s.ebl * RULES.poolPerMl, 6);
    expect(wait(ruptured(), 60).pooled).toBe(RULES.poolMax);
  });

  it('hides the field once the pool is deep, refusing the dissector and the clip until it is suctioned', () => {
    const wet = wait(openedAndFree(), 0.1);
    const deep = { ...wet, pooled: RULES.obstructedAtPool };
    expect(isObstructed(deep)).toBe(true);
    expect(act(deep, use('dissector', NECK)).events[0]!.code).toBe('obstructed');
    expect(act(deep, use('clip', NECK)).events[0]!.code).toBe('obstructed');
    expect(act(deep, use('clip', NECK)).state.clip).toBeNull();
    const clear = run(deep, hold('suction', NONE, 2));
    expect(isObstructed(clear)).toBe(false);
    expect(act(clear, use('clip', NECK)).state.clip).not.toBeNull();
  });

  it('is kept in check by suction when the temporary clip is on, but not when the rupture is wide open', () => {
    const suctionFrame = (s: FieldState, dt: number): FieldState => act(tick(s, dt), hold('suction', NONE, dt)).state;
    let open = ruptured();
    for (let i = 0; i < 40; i++) open = suctionFrame(open, 0.25);
    expect(open.pooled).toBeGreaterThan(0);
    let controlled = run(ruptured(), use('tempClip', ICA));
    for (let i = 0; i < 40; i++) controlled = suctionFrame(controlled, 0.25);
    expect(controlled.pooled).toBe(0);
    expect(controlled.ebl).toBeLessThan(open.ebl);
  });
});

describe('a ruptured case', () => {
  it('can be rescued by suction, a temporary clip and then the clip, with the vitals recovering', () => {
    let s = openedAndFree();
    s = run(s, use('scissors', DOME));
    expect(s.ruptured).toBe(true);
    // Untreated, the field is soon too wet to work in.
    s = wait(s, 2);
    s = run(s, use('tempClip', ICA));
    for (let i = 0; i < 24; i++) s = act(tick(s, 0.25), hold('suction', NONE, 0.25)).state;
    expect(isObstructed(s)).toBe(false);
    s = run(s, use('clip', NECK));
    expect(s.clip).not.toBeNull();
    s = run(s, use('tempClip', ICA));
    expect(bleedRate(s)).toBeGreaterThanOrEqual(0);
    const lost = s.ebl;
    s = wait(s, 120);
    expect(s.ebl).toBeCloseTo(lost + 120 * bleedRate(s), 3);
    expect(s.vitals.sbp).toBeGreaterThan(RULES.vitals.lowSbp);
    expect(s.vitals.mep).toBeGreaterThan(RULES.vitals.lowMep);
  });

  it('goes into shock if nothing is done for a long time', () => {
    const s = wait(ruptured(), 240, 1);
    expect(s.vitals.sbp).toBeLessThan(RULES.vitals.lowSbp);
    expect(alarmFor(s.vitals)).not.toBeNull();
  });

  it('has the mentor speak up as the pressure and the MEP cross their lines, once each', () => {
    let s = ruptured();
    const notes: string[] = [];
    for (let i = 0; i < 400; i++) {
      const prev = s;
      s = tick(s, 1);
      notes.push(...notesFor(prev, s, []).map((n) => n.text));
    }
    expect(notes.filter((t) => t.includes('Blood pressure is falling'))).toHaveLength(1);
    expect(notes.filter((t) => t.includes('motor evoked potentials are falling'))).toHaveLength(1);
  });

  it('has the mentor explain a refusal because of blood', () => {
    const deep = { ...openedAndFree(), pooled: RULES.obstructedAtPool };
    const r = act(deep, use('clip', NECK));
    expect(notesFor(deep, r.state, r.events).map((n) => n.tone)).toEqual(['warn']);
  });
});
