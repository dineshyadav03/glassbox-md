import { describe, expect, it } from 'vitest';
import { PHYSIOLOGY } from '../src/config/anatomy';
import {
  BASELINE_WINDOW,
  ST_SEGMENT_WINDOW,
  cardiacPhase,
  ecgSampleMv,
} from '../src/physics/ecg';
import {
  INITIAL_PHYSIOLOGY,
  giveHeparin,
  ischaemiaSeverity,
  stepPhysiology,
  vitalsOf,
  type PhysiologyState,
} from '../src/physics/physiology';

const OCCLUDED = 0;
const OPEN = 1;
const UNTREATED_LESION = 0.446; // flowFactor(0.9): TIMI 2

/** Run the model for `seconds` at a constant flow. */
function run(state: PhysiologyState, flow: number, seconds: number, dt = 0.1): PhysiologyState {
  let s = state;
  for (let t = 0; t < seconds - 1e-9; t += dt) s = stepPhysiology(s, flow, dt);
  return s;
}

describe('the baseline patient', () => {
  it('starts calm: no ST change, normal vitals, ACT 128 s', () => {
    const v = vitalsOf(INITIAL_PHYSIOLOGY);
    expect(v).toMatchObject({
      heartRate: 72, systolic: 128, diastolic: 76, spo2: 98, stMm: 0,
      pvc: false, unstable: false, chestPain: false, alarm: false, message: null, actSeconds: 128,
    });
  });

  it('stays calm with an untreated 90% lesion (TIMI 2) or open flow', () => {
    for (const flow of [OPEN, UNTREATED_LESION]) {
      const s = run(INITIAL_PHYSIOLOGY, flow, 120);
      expect(s.ischaemia).toBe(0);
      expect(vitalsOf(s).stMm).toBe(0);
    }
  });
});

describe('ischaemia', () => {
  it('maps flow to a severity: none at TIMI 2, full when occluded, graded between', () => {
    expect(ischaemiaSeverity(1)).toBe(0);
    expect(ischaemiaSeverity(PHYSIOLOGY.poorFlowBelow)).toBe(0);
    expect(ischaemiaSeverity(PHYSIOLOGY.occludedBelow)).toBe(1);
    expect(ischaemiaSeverity(0)).toBe(1);
    let previous = 0;
    for (let f = 0.3; f >= 0; f -= 0.01) {
      const sev = ischaemiaSeverity(f);
      expect(sev).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = sev;
    }
  });

  it('rises about linearly to full over about 20 s of occlusion', () => {
    expect(run(INITIAL_PHYSIOLOGY, OCCLUDED, 10).ischaemia).toBeCloseTo(0.5, 2);
    expect(run(INITIAL_PHYSIOLOGY, OCCLUDED, 20).ischaemia).toBeCloseTo(1, 2);
    expect(run(INITIAL_PHYSIOLOGY, OCCLUDED, 90).ischaemia).toBe(1);
  });

  it('raises ST in V2 up to 4 mm', () => {
    expect(vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 10)).stMm).toBeCloseTo(2, 1);
    expect(vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 40)).stMm).toBeCloseTo(4, 6);
  });

  it('also rises, but only part way, for very poor flow', () => {
    const s = run(INITIAL_PHYSIOLOGY, 0.1, 60);
    expect(s.ischaemia).toBeCloseTo(ischaemiaSeverity(0.1), 6);
    expect(s.ischaemia).toBeGreaterThan(0.3);
    expect(s.ischaemia).toBeLessThan(1);
  });

  it('recovers after reperfusion with a time constant of about 8 s', () => {
    const peak = run(INITIAL_PHYSIOLOGY, OCCLUDED, 20);
    expect(run(peak, OPEN, 8).ischaemia).toBeCloseTo(Math.exp(-1), 2);
    expect(run(peak, OPEN, 40).ischaemia).toBeLessThan(0.01);
    expect(vitalsOf(run(peak, OPEN, 40)).stMm).toBeLessThan(0.04);
  });

  it('never leaves 0 to 1', () => {
    let s = INITIAL_PHYSIOLOGY;
    for (const flow of [0, 1, 0, 0.1, 0.5, 0, 1]) {
      s = run(s, flow, 15);
      expect(s.ischaemia).toBeGreaterThanOrEqual(0);
      expect(s.ischaemia).toBeLessThanOrEqual(1);
    }
  });

  it('raises the heart rate with ischaemia and reports chest pain above a threshold', () => {
    const early = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 4));
    const late = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 30));
    expect(early.chestPain).toBe(false);
    expect(late.chestPain).toBe(true);
    expect(late.heartRate).toBeGreaterThan(early.heartRate);
    expect(late.message).toMatch(/chest pain|unstable/i);
  });
});

describe('prolonged occlusion', () => {
  it('drops the blood pressure and adds ectopic beats only after 40 s', () => {
    const before = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 39));
    expect(before.pvc).toBe(false);
    expect(before.systolic).toBe(128);
    const after = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 50));
    expect(after.pvc).toBe(true);
    expect(after.systolic).toBeLessThan(128);
    expect(after.diastolic).toBeLessThan(76);
  });

  it('is not unstable just under 60 s but is just beyond it, with an alarm and a "Deflate now" message', () => {
    // Either side of the threshold rather than on it: summing 0.1 s steps drifts by about 1e-12.
    const under = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 59.8));
    expect(under.unstable).toBe(false);
    expect(under.alarm).toBe(false);
    const past = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 60.5));
    expect(past.unstable).toBe(true);
    expect(past.alarm).toBe(true);
    expect(past.message).toMatch(/Deflate now/);
    expect(past.spo2).toBeLessThan(98);
  });

  it('bounds the pressure drop', () => {
    const v = vitalsOf(run(INITIAL_PHYSIOLOGY, OCCLUDED, 300));
    expect(v.systolic).toBe(128 - PHYSIOLOGY.maxBpDrop);
    expect(v.spo2).toBeGreaterThanOrEqual(92);
  });

  it('resets the clock as soon as flow returns, so a brief release avoids instability', () => {
    let s = run(INITIAL_PHYSIOLOGY, OCCLUDED, 30);
    s = run(s, 0.3, 1);
    expect(s.occludedSeconds).toBe(0);
    s = run(s, OCCLUDED, 35);
    expect(vitalsOf(s).pvc).toBe(false);
    expect(vitalsOf(s).unstable).toBe(false);
  });
});

describe('heparin and ACT', () => {
  it('leaves ACT at baseline until heparin is given', () => {
    expect(run(INITIAL_PHYSIOLOGY, OPEN, 600).actSeconds).toBe(128);
  });

  it('raises ACT from 128 s toward 285 s, monotonically and without overshoot', () => {
    let s = giveHeparin(INITIAL_PHYSIOLOGY);
    let previous = s.actSeconds;
    for (let t = 0; t < 180; t += 1) {
      s = run(s, OPEN, 1);
      expect(s.actSeconds).toBeGreaterThanOrEqual(previous);
      expect(s.actSeconds).toBeLessThanOrEqual(285);
      previous = s.actSeconds;
    }
    expect(s.actSeconds).toBeGreaterThan(280);
  });

  it('is therapeutic (over 250 s) within a minute or so', () => {
    expect(run(giveHeparin(INITIAL_PHYSIOLOGY), OPEN, 40).actSeconds).toBeGreaterThan(250);
  });

  it('gives heparin once; a second dose changes nothing', () => {
    const once = giveHeparin(INITIAL_PHYSIOLOGY);
    expect(once.heparinGiven).toBe(true);
    expect(giveHeparin(once)).toBe(once);
  });

  it('does not mutate its input', () => {
    const frozen = Object.freeze({ ...INITIAL_PHYSIOLOGY });
    expect(() => stepPhysiology(frozen, OCCLUDED, 1)).not.toThrow();
    expect(frozen.ischaemia).toBe(0);
  });
});

describe('synthetic ECG', () => {
  const mean = (window: readonly [number, number], options: { stMm: number; pvc?: boolean }) => {
    let sum = 0;
    let n = 0;
    for (let p = window[0]; p <= window[1] + 1e-9; p += 0.002) {
      sum += ecgSampleMv(p, options);
      n++;
    }
    return sum / n;
  };

  it('tracks the phase of the cycle from time and heart rate', () => {
    expect(cardiacPhase(0, 60)).toBe(0);
    expect(cardiacPhase(0.5, 60)).toBeCloseTo(0.5);
    expect(cardiacPhase(1, 60)).toBeCloseTo(0);
    expect(cardiacPhase(0.25, 120)).toBeCloseTo(0.5);
    for (let t = 0; t < 10; t += 0.37) {
      const phase = cardiacPhase(t, 83);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it('has the usual V2 shape: a small P, a small r, a deep S, an upright T, and a quiet baseline', () => {
    const normal = { stMm: 0 };
    expect(ecgSampleMv(0.1, normal)).toBeGreaterThan(0.05);
    expect(ecgSampleMv(0.21, normal)).toBeGreaterThan(0.2);
    expect(ecgSampleMv(0.235, normal)).toBeLessThan(-0.7);
    expect(ecgSampleMv(0.4, normal)).toBeGreaterThan(0.3);
    expect(Math.abs(mean(BASELINE_WINDOW, normal))).toBeLessThan(0.01);
  });

  it('lifts the ST segment by 0.1 mV for every mm of elevation', () => {
    const flat = mean(ST_SEGMENT_WINDOW, { stMm: 0 });
    for (const mm of [1, 2, 3, 4]) {
      expect(mean(ST_SEGMENT_WINDOW, { stMm: mm }) - flat).toBeCloseTo(mm * 0.1, 2);
    }
  });

  it('raises the ST segment monotonically and leaves the baseline alone', () => {
    let previous = -Infinity;
    for (let mm = 0; mm <= 4; mm += 0.5) {
      const level = mean(ST_SEGMENT_WINDOW, { stMm: mm });
      expect(level).toBeGreaterThan(previous);
      previous = level;
      expect(Math.abs(mean(BASELINE_WINDOW, { stMm: mm }))).toBeLessThan(0.01);
    }
  });

  it('draws an ectopic beat wide, with no P wave', () => {
    const width = (options: { stMm: number; pvc?: boolean }) => {
      let n = 0;
      for (let p = 0; p < 1; p += 0.002) if (Math.abs(ecgSampleMv(p, options)) > 0.3) n++;
      return n;
    };
    expect(width({ stMm: 0, pvc: true })).toBeGreaterThan(width({ stMm: 0 }));
    expect(Math.abs(ecgSampleMv(0.1, { stMm: 0, pvc: true }))).toBeLessThan(0.05);
  });

  it('is deterministic', () => {
    expect(ecgSampleMv(0.33, { stMm: 2 })).toBe(ecgSampleMv(0.33, { stMm: 2 }));
  });
});
