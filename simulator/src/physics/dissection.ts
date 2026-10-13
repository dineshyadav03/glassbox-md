/**
 * Dissections (a tear in the vessel wall): where they come from and when a stent seals them.
 * Pure functions. Units: mm.
 */
import { LUMEN, type VesselId } from '../config/anatomy';
import type { Treatment } from './lesion';

export type DissectionCause = 'wire' | 'balloon' | 'stent' | 'rupture';

export interface Dissection {
  readonly vessel: VesselId;
  readonly s: number;
  readonly cause: DissectionCause;
  /** True once a deployed stent covers `s`. Recomputed by `refreshSealing`. */
  readonly sealed: boolean;
}

/** Is `s` inside the working length of a deployed stent on this vessel? */
export function isSealed(vessel: VesselId, s: number, treatments: readonly Treatment[]): boolean {
  return treatments.some(
    (treatment) =>
      treatment.kind === 'stent' && treatment.vessel === vessel && Math.abs(s - treatment.centreS) <= treatment.length / 2,
  );
}

export function makeDissection(
  vessel: VesselId,
  s: number,
  cause: DissectionCause,
  treatments: readonly Treatment[] = [],
): Dissection {
  return { vessel, s, cause, sealed: isSealed(vessel, s, treatments) };
}

/** Recompute `sealed` for every dissection against the current treatments. */
export function refreshSealing(dissections: readonly Dissection[], treatments: readonly Treatment[]): Dissection[] {
  return dissections.map((d) => ({ ...d, sealed: isSealed(d.vessel, d.s, treatments) }));
}

/**
 * A balloon or stent larger than this ratio of the vessel's reference diameter tears the wall.
 * Exactly at the ratio is not oversized; the tolerance stops floating point (1.2 * 3.0 is
 * 3.5999999999999996) from turning an exact boundary into a dissection.
 */
export function isOversized(achievedDiameter: number, referenceDiameter: number): boolean {
  return achievedDiameter > LUMEN.oversizeRatio * referenceDiameter + 1e-9;
}

/** An oversized stent's edge dissection sits just beyond its distal end, so the stent does not cover it. */
export function edgeDissectionS(stentCentreS: number, stentLength: number): number {
  return stentCentreS + stentLength / 2 + LUMEN.edgeDissectionOffsetMm;
}

export function unsealed(dissections: readonly Dissection[]): Dissection[] {
  return dissections.filter((d) => !d.sealed);
}
