/**
 * Flow and contrast transit through the left coronary system. Pure functions.
 *
 * The model is deliberately simple. Each vessel is a row of "rings" a fixed distance
 * apart. Dye reaches a ring after a time set by how fast it can travel, and its speed is
 * limited by the tightest narrowing anywhere upstream of it (branches inherit the limit
 * of their parent at the point where they leave). An inflated balloon stops flow beyond
 * it; an unsealed dissection slows everything beyond it. This is a teaching model of
 * "narrower means slower and fainter", not haemodynamics.
 */
import {
  BALLOON_OCCLUSION_FRACTION,
  CONTRAST,
  FLOW,
  LEFT_SYSTEM,
  VESSELS,
  type VesselId,
} from '../config/anatomy';
import type { Dissection } from './dissection';
import { diameterStenosis, lumenDiameterAt, referenceDiameterAt, type Treatment } from './lesion';

/** Fraction of normal flow (1 = unrestricted, 0 = none) for a diameter stenosis fraction. */
export function flowFactor(ds: number): number {
  if (ds < FLOW.fullFlowBelowDs) return 1;
  if (ds >= FLOW.noFlowAtDs) return 0;
  const t = (ds - FLOW.fullFlowBelowDs) / (FLOW.noFlowAtDs - FLOW.fullFlowBelowDs);
  return 1 - Math.pow(t, FLOW.falloffExponent);
}

export type TimiGrade = 0 | 1 | 2 | 3;

/** TIMI-style flow grade from a flow factor. */
export function timiGrade(factor: number): TimiGrade {
  if (factor >= FLOW.timi3At) return 3;
  if (factor >= FLOW.timi2At) return 2;
  if (factor > FLOW.timi1Above) return 1;
  return 0;
}

export interface FlowScene {
  readonly treatments: readonly Treatment[];
  readonly dissections: readonly Dissection[];
}

export interface FlowResult {
  /** Seconds until dye reaches each ring; Infinity if it never does. Index i is arc position i * ringSpacing (the last is the vessel end). */
  readonly arrival: Readonly<Record<VesselId, readonly number[]>>;
  /** Flow factor at each ring after upstream narrowing, dissections and any balloon occlusion. */
  readonly factor: Readonly<Record<VesselId, readonly number[]>>;
}

export function ringPositions(vessel: VesselId): number[] {
  const { length } = VESSELS[vessel];
  const positions: number[] = [];
  for (let s = 0; s < length; s += FLOW.ringSpacing) positions.push(s);
  positions.push(length);
  return positions;
}

/** The proximal end of an inflated balloon that seals this vessel, if there is one. */
function occlusionStart(vessel: VesselId, treatments: readonly Treatment[]): number | null {
  let start: number | null = null;
  for (const t of treatments) {
    if (t.kind !== 'balloon-live' || t.vessel !== vessel) continue;
    if (t.diameter < BALLOON_OCCLUSION_FRACTION * referenceDiameterAt(vessel, t.centreS)) continue;
    const proximalEnd = t.centreS - t.length / 2;
    start = start === null ? proximalEnd : Math.min(start, proximalEnd);
  }
  return start;
}

function nearestRing(vessel: VesselId, s: number): number {
  const last = ringPositions(vessel).length - 1;
  return Math.min(last, Math.max(0, Math.round(s / FLOW.ringSpacing)));
}

/** Contrast arrival times and flow factors for the whole left system. */
export function simulateFlow(scene: FlowScene): FlowResult {
  const arrival = {} as Record<VesselId, number[]>;
  const factor = {} as Record<VesselId, number[]>;

  for (const vessel of LEFT_SYSTEM) {
    const spec = VESSELS[vessel];
    const positions = ringPositions(vessel);
    const blockedFrom = occlusionStart(vessel, scene.treatments);

    // Entry state: the left main starts clean; a branch inherits its parent's state where it leaves.
    let time = 0;
    let running = 1;
    if (spec.parent !== null) {
      const at = nearestRing(spec.parent, spec.branchS);
      time = arrival[spec.parent][at] ?? Infinity;
      running = factor[spec.parent][at] ?? 0;
    }

    const times: number[] = [];
    const factors: number[] = [];
    let previousS = -Infinity;
    positions.forEach((s, i) => {
      const local = flowFactor(diameterStenosis(lumenDiameterAt(vessel, s, scene.treatments), referenceDiameterAt(vessel, s)));
      running = Math.min(running, local);
      for (const d of scene.dissections) {
        if (!d.sealed && d.vessel === vessel && d.s > previousS && d.s <= s) running *= FLOW.dissectionFactor;
      }
      const occluded = blockedFrom !== null && s > blockedFrom;
      const here = occluded ? 0 : running;

      if (i > 0) {
        const speed = FLOW.baseSpeed * here;
        time = speed > 0 ? time + (s - previousS) / speed : Infinity;
      }
      times.push(time);
      factors.push(here);
      previousS = s;
    });
    arrival[vessel] = times;
    factor[vessel] = factors;
  }

  // A branch that leaves downstream of an inflated balloon needs no special case: it inherits the
  // parent's zero flow (and infinite arrival) at its branch point above.
  return { arrival, factor };
}

/** The flow grade at the far end of a vessel. */
export function timiForVessel(scene: FlowScene, vessel: VesselId): TimiGrade {
  const factors = simulateFlow(scene).factor[vessel];
  return timiGrade(factors[factors.length - 1] ?? 0);
}

/** The flow factor at the far end of a vessel, used to drive the patient's physiology. */
export function distalFlowFactor(scene: FlowScene, vessel: VesselId): number {
  const factors = simulateFlow(scene).factor[vessel];
  return factors[factors.length - 1] ?? 0;
}

/** How long a cine run lasts: until the slowest vessel has filled and washed out, within sensible limits. */
export function cineDurationSeconds(result: FlowResult): number {
  let slowest = 0;
  for (const vessel of LEFT_SYSTEM) {
    for (const t of result.arrival[vessel]) {
      if (Number.isFinite(t)) slowest = Math.max(slowest, t);
    }
  }
  return Math.min(FLOW.maxCineSeconds, Math.max(FLOW.minCineSeconds, slowest + FLOW.washoutSeconds));
}

/** Contrast used by one injection. Selective needs the guide engaged; otherwise it is an aortic root flush. */
export function contrastVolumeMl(selective: boolean): number {
  return selective ? CONTRAST.selectiveMl : CONTRAST.aorticMl;
}
