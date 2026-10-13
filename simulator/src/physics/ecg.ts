/**
 * A synthetic V2 ECG, one sample at a time, built from Gaussian waves. Pure functions.
 * It is a drawing aid for the monitor, not a diagnostic tracing. Output is in millivolts;
 * 1 mm of ST elevation is 0.1 mV.
 */
import { PHYSIOLOGY } from '../config/anatomy';

/** Where in the beat (0 to 1) the ST segment is flat, used by tests and by the monitor. */
export const ST_SEGMENT_WINDOW: readonly [number, number] = [0.32, 0.36];
/** The quiet stretch between the T wave and the next P wave. */
export const BASELINE_WINDOW: readonly [number, number] = [0.94, 0.99];

/** Position in the cardiac cycle, 0 to 1, at `timeS` for a heart rate in beats per minute. */
export function cardiacPhase(timeS: number, heartRate: number): number {
  const beats = (timeS * heartRate) / 60;
  return beats - Math.floor(beats);
}

function gaussian(x: number, centre: number, width: number, amplitude: number): number {
  const z = (x - centre) / width;
  return amplitude * Math.exp(-z * z);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 1 across the ST segment and the early T wave, easing to 0 on either side. */
function stWindow(phase: number): number {
  return smoothstep(0.25, 0.3, phase) * (1 - smoothstep(0.42, 0.47, phase));
}

export interface EcgOptions {
  /** ST elevation, mm. */
  readonly stMm: number;
  /** This beat is a premature ventricular contraction. */
  readonly pvc?: boolean;
}

/** The V2 voltage, in mV, at a point in the beat. */
export function ecgSampleMv(phase: number, options: EcgOptions): number {
  if (options.pvc) {
    // Wide, deep, no P wave, and a discordant T wave.
    return gaussian(phase, 0.24, 0.045, -1.8) + gaussian(phase, 0.45, 0.06, 0.8);
  }
  const p = gaussian(phase, 0.1, 0.025, 0.1);
  const q = gaussian(phase, 0.19, 0.008, -0.05);
  const r = gaussian(phase, 0.21, 0.01, 0.35);
  const s = gaussian(phase, 0.235, 0.012, -1.0);
  const t = gaussian(phase, 0.4, 0.05, 0.45);
  const elevation = options.stMm * PHYSIOLOGY.mvPerMm * stWindow(phase);
  return p + q + r + s + t + elevation;
}
