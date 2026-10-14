/**
 * The patient's vital signs as a small teaching model: blood loss pulls the heart rate up and the pressure and
 * oxygen down, with a lag, and a long temporary occlusion lowers the motor evoked potentials (MEP). Pure functions;
 * every number is in `config/rules.ts` and is invented.
 */
import { RULES } from '../config/rules';

export interface Vitals {
  readonly hr: number;
  readonly sbp: number;
  readonly dbp: number;
  readonly spo2: number;
  /** Motor evoked potentials as a percentage of baseline. */
  readonly mep: number;
  /** The lowest the MEP has been, for the debrief. */
  readonly mepMin: number;
}

export function baselineVitals(): Vitals {
  const v = RULES.vitals;
  return { hr: v.hr, sbp: v.sbp, dbp: v.dbp, spo2: v.spo2, mep: 100, mepMin: 100 };
}

/** How far blood loss has gone toward the point where the body can no longer compensate, 0 to 1. */
export function lossFraction(eblMl: number): number {
  return Math.min(1, Math.max(0, eblMl / RULES.vitals.hypovolaemiaMl));
}

const approach = (value: number, target: number, dt: number): number => value + (target - value) * (1 - Math.exp(-dt / RULES.vitals.tauSeconds));

/** Move the vitals on by `dt` seconds. */
export function stepVitals(v: Vitals, eblMl: number, tempClipOn: boolean, tempClipSeconds: number, dt: number): Vitals {
  const b = RULES.vitals;
  const f = lossFraction(eblMl);
  const hr = approach(v.hr, b.hr + b.hrRise * f, dt);
  const sbp = approach(v.sbp, b.sbp - b.sbpFall * f, dt);
  const dbp = approach(v.dbp, b.dbp - b.dbpFall * f, dt);
  const spo2 = approach(v.spo2, b.spo2 - b.spo2Fall * f * f, dt);
  let mep = v.mep;
  if (tempClipOn && tempClipSeconds > b.mepGraceSeconds) mep -= b.mepDropPerSecond * dt;
  else if (!tempClipOn && sbp >= b.lowSbp) mep += b.mepRecoverPerSecond * dt;
  // Very low pressure also starves the cord.
  if (sbp < b.lowSbp) mep -= b.mepDropPerSecond * 0.5 * dt;
  mep = Math.min(100, Math.max(0, mep));
  return { hr, sbp, dbp, spo2, mep, mepMin: Math.min(v.mepMin, mep) };
}

export interface Alarm {
  readonly text: string;
}

/** The monitor's alarm banner, or null when nothing is out of range. */
export function alarmFor(v: Vitals): Alarm | null {
  const b = RULES.vitals;
  if (v.sbp < b.lowSbp) return { text: 'Low blood pressure' };
  if (v.spo2 < b.lowSpo2) return { text: 'Low oxygen saturation' };
  if (v.mep < b.lowMep) return { text: 'Motor evoked potentials falling' };
  if (v.hr > b.highHr) return { text: 'Fast heart rate' };
  return null;
}
