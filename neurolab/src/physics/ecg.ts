/**
 * A synthetic ECG, one sample at a time, built from Gaussian waves. Pure functions. It is a drawing aid for the
 * monitor, not a diagnostic tracing. Output is in millivolts.
 */

/** Position in the cardiac cycle, 0 to 1, at `timeS` for a heart rate in beats per minute. */
export function cardiacPhase(timeS: number, heartRate: number): number {
  const beats = (timeS * heartRate) / 60;
  return beats - Math.floor(beats);
}

function gaussian(x: number, centre: number, width: number, amplitude: number): number {
  const z = (x - centre) / width;
  return amplitude * Math.exp(-z * z);
}

/** The voltage, in mV, at a point in the beat (0 to 1). */
export function ecgSampleMv(phase: number): number {
  const p = gaussian(phase, 0.1, 0.025, 0.12);
  const q = gaussian(phase, 0.19, 0.008, -0.1);
  const r = gaussian(phase, 0.21, 0.01, 1.0);
  const s = gaussian(phase, 0.235, 0.012, -0.25);
  const t = gaussian(phase, 0.4, 0.05, 0.3);
  return p + q + r + s + t;
}
