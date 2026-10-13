/**
 * The lesion and the lumen: how wide each vessel is at each point, untreated and after a
 * balloon or stent. Pure functions only (no Three.js, no DOM). Units: mm.
 */
import { LESION, LUMEN, STENT, VESSELS, type VesselId } from '../config/anatomy';

/** Reference (healthy) diameter at arc position `s`, a linear taper along the vessel. */
export function referenceDiameterAt(vessel: VesselId, s: number): number {
  const spec = VESSELS[vessel];
  const t = Math.min(1, Math.max(0, s / spec.length));
  return spec.diameterProximal + (spec.diameterDistal - spec.diameterProximal) * t;
}

/** How much of the lesion's full narrowing applies at `s`: 1 on the plateau, a cosine taper to 0 at the ends. */
export function lesionWeight(s: number): number {
  const distance = Math.abs(s - LESION.centreS);
  const plateauHalf = LESION.plateau / 2;
  const half = LESION.length / 2;
  if (distance <= plateauHalf) return 1;
  if (distance >= half) return 0;
  const t = (distance - plateauHalf) / (half - plateauHalf);
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/** The lumen before any treatment. Only the lesion vessel is narrowed. */
export function untreatedDiameterAt(vessel: VesselId, s: number): number {
  const reference = referenceDiameterAt(vessel, s);
  if (vessel !== LESION.vessel) return reference;
  return reference * (1 - LESION.diameterStenosis * lesionWeight(s));
}

/** Diameter stenosis as a fraction of the reference (0 = none). Never negative. */
export function diameterStenosis(lumen: number, reference: number): number {
  return Math.max(0, 1 - lumen / reference);
}

/** The reference diameter at the middle of the lesion, which a stent is sized against. */
export function lesionReferenceDiameter(): number {
  return referenceDiameterAt(LESION.vessel, LESION.centreS);
}

export type TreatmentKind = 'balloon-live' | 'balloon-done' | 'stent';

/**
 * A treated segment of a vessel.
 * - `balloon-live`: a balloon inflated right now; the vessel is stretched to its diameter.
 * - `balloon-done`: a deflated balloon; `diameter` is the largest it reached, and the vessel
 *   recoils by LUMEN.balloonRecoil.
 * - `stent`: a deployed stent; `diameter` is its expanded diameter, with a small recoil.
 */
export interface Treatment {
  readonly kind: TreatmentKind;
  readonly vessel: VesselId;
  readonly centreS: number;
  readonly length: number;
  readonly diameter: number;
}

function treatedDiameter(treatment: Treatment): number {
  switch (treatment.kind) {
    case 'balloon-live':
      return treatment.diameter;
    case 'balloon-done':
      return treatment.diameter * (1 - LUMEN.balloonRecoil);
    case 'stent':
      return treatment.diameter * (1 - STENT.recoil);
  }
}

/** 1 inside the segment, ramping smoothly to 0 at its two ends. */
function segmentWeight(treatment: Treatment, s: number): number {
  const half = treatment.length / 2;
  const distance = Math.abs(s - treatment.centreS);
  if (distance >= half) return 0;
  const taper = Math.min(LUMEN.edgeTaperMm, half);
  if (distance <= half - taper) return 1;
  const t = (distance - (half - taper)) / taper;
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/** The lumen at `s`: the untreated vessel, opened (never narrowed) by any treatment that reaches it. */
export function lumenDiameterAt(vessel: VesselId, s: number, treatments: readonly Treatment[] = []): number {
  const base = untreatedDiameterAt(vessel, s);
  let lumen = base;
  for (const treatment of treatments) {
    if (treatment.vessel !== vessel) continue;
    const target = treatedDiameter(treatment);
    if (target <= base) continue;
    lumen = Math.max(lumen, base + (target - base) * segmentWeight(treatment, s));
  }
  return lumen;
}

/** The narrowest point across the lesion, as a fraction of the reference there. */
export function worstResidualStenosis(treatments: readonly Treatment[] = [], samples = 57): number {
  let worst = 0;
  for (let i = 0; i < samples; i++) {
    const s = LESION.centreS - LESION.length / 2 + (LESION.length * i) / (samples - 1);
    const lumen = lumenDiameterAt(LESION.vessel, s, treatments);
    worst = Math.max(worst, diameterStenosis(lumen, referenceDiameterAt(LESION.vessel, s)));
  }
  return worst;
}
