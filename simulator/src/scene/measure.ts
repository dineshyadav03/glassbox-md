/**
 * Hover measurement: turn a point on a coronary artery in the 3D view into "which vessel, how far along it, and how
 * wide is the lumen there". Pure, so the numbers shown can be tested; the viewer only finds the point under the pointer.
 */
import { VESSEL_ORDER, type VesselId } from '../config/anatomy';
import { anatomyPaths } from '../anatomy/centrelines';
import { distance, type Vec3 } from '../anatomy/vec3';
import { diameterStenosis, lumenDiameterAt, referenceDiameterAt, type Treatment } from '../physics/lesion';

export interface Measurement {
  readonly vessel: VesselId;
  /** Distance along the vessel from where it starts, mm. */
  readonly s: number;
  /** The lumen there now (narrowed by the lesion, opened by any balloon or stent), mm. */
  readonly lumenMm: number;
  /** What a healthy vessel would be at that point, mm. */
  readonly referenceMm: number;
  /** Diameter stenosis at that point as a fraction (0 = none). */
  readonly stenosis: number;
  /** How far the point was from the vessel's centreline, mm. */
  readonly offMm: number;
}

export interface Sample {
  readonly vessel: VesselId;
  readonly s: number;
  readonly p: Vec3;
}

const STEP = 0.5;
let samples: Sample[] | null = null;

function allSamples(): Sample[] {
  if (samples) return samples;
  const out: Sample[] = [];
  const { vessels } = anatomyPaths();
  for (const vessel of VESSEL_ORDER) {
    const path = vessels[vessel];
    for (let s = 0; s <= path.length + 1e-9; s += STEP) out.push({ vessel, s: Math.min(s, path.length), p: path.positionAt(Math.min(s, path.length)) });
  }
  samples = out;
  return out;
}

/** Points along every vessel's centreline, every half millimetre, in the heart's own frame. */
export function measureSamples(): readonly Sample[] {
  return allSamples();
}

/** How near to a centreline a point must be to count as on that vessel, mm. */
export const MAX_OFF_VESSEL_MM = 6;

/**
 * Measure at a point given in the heart's own frame (the frame the coronary centrelines are in). Returns null if
 * the point is not near any vessel. A point close to a branch is given to whichever centreline is nearer.
 */
export function measureAtPoint(point: Vec3, treatments: readonly Treatment[] = [], maxOffMm = MAX_OFF_VESSEL_MM): Measurement | null {
  let best: Sample | null = null;
  let bestDistance = Infinity;
  for (const sample of allSamples()) {
    const d = distance(point, sample.p);
    if (d < bestDistance) {
      bestDistance = d;
      best = sample;
    }
  }
  if (!best || bestDistance > maxOffMm) return null;
  const lumen = lumenDiameterAt(best.vessel, best.s, treatments);
  const reference = referenceDiameterAt(best.vessel, best.s);
  return { vessel: best.vessel, s: best.s, lumenMm: lumen, referenceMm: reference, stenosis: diameterStenosis(lumen, reference), offMm: bestDistance };
}

/** The lines of the hover read-out. */
export function measurementLines(m: Measurement): string[] {
  const pct = Math.round(m.stenosis * 100);
  return [
    `${m.vessel}, ${m.s.toFixed(1)} mm from its start`,
    `Lumen ${m.lumenMm.toFixed(2)} mm (healthy ${m.referenceMm.toFixed(2)} mm)`,
    pct > 0 ? `${pct}% diameter stenosis` : 'No narrowing here',
  ];
}
