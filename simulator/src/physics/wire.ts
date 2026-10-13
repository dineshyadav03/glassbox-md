/**
 * The 0.014" guidewire on the coronary rail. It leaves the engaged guide into the left main;
 * at each bifurcation the rotation of its shaped tip picks the branch; inside the lesion,
 * pushing faster than a safe speed buckles it and builds a hidden risk of dissection that is
 * rolled once, when the tip crosses. Pure functions over plain data (the random draw is
 * passed in, so tests are deterministic). Units: mm, degrees, seconds.
 */
import {
  LESION,
  LESION_END,
  LESION_START,
  VESSELS,
  WIRE,
  childrenOf,
  pathOffsetOf,
  type VesselId,
  type VesselSpec,
} from '../config/anatomy';
import { angleDiffDeg, normalizeDeg } from './angles';

export interface WireState {
  /** The tip is beyond the guide. */
  readonly outOfGuide: boolean;
  readonly vessel: VesselId | null;
  /** Tip position along `vessel`, mm. */
  readonly s: number;
  readonly rotationDeg: number;
  /** 0 to 1, shown as the resistance meter. */
  readonly resistance: number;
  readonly buckled: boolean;
  /** Hidden, 0 to 1. */
  readonly dissectionRisk: number;
  /** Total seconds spent pushing past the safe speed inside the lesion. */
  readonly forcingSeconds: number;
  /** The one-off dissection roll for this crossing has been made. */
  readonly crossingResolved: boolean;
  readonly dissected: boolean;
  readonly warnedEnd: boolean;
}

export interface WireInput {
  /** Signed speed, mm/s (positive advances). */
  readonly advanceSpeed: number;
  readonly rotateRate: number;
}

export interface WireContext {
  readonly guideEngaged: boolean;
  /** A balloon or stent catheter is on the wire. */
  readonly balloonOnWire: boolean;
}

export type WireEvent =
  | { readonly type: 'needs-engaged-guide' }
  | { readonly type: 'held-by-balloon' }
  | { readonly type: 'entered'; readonly vessel: VesselId }
  | { readonly type: 'back-in-guide' }
  | { readonly type: 'buckling' }
  | { readonly type: 'crossed' }
  | { readonly type: 'dissection'; readonly s: number }
  | { readonly type: 'near-vessel-end' }
  | { readonly type: 'vessel-end' };

export function createWire(): WireState {
  return {
    outOfGuide: false,
    vessel: null,
    s: 0,
    rotationDeg: 0,
    resistance: 0,
    buckled: false,
    dissectionRisk: 0,
    forcingSeconds: 0,
    crossingResolved: false,
    dissected: false,
    warnedEnd: false,
  };
}

/** The fastest the wire may be pushed through the lesion without forcing; spinning it raises this. */
export function safeSpeed(rotateRate: number): number {
  const spin = Math.min(1, Math.abs(rotateRate) / WIRE.spinReferenceRate);
  return WIRE.safeSpeed * (1 + WIRE.torqueSafeSpeedGain * spin);
}

/**
 * Which child a tip with this rotation enters at a bifurcation. Where the parent carries on,
 * a branch is entered only if the tip is within the capture window of its angle (nearest
 * wins); where the parent ends, the nearest branch angle wins whatever the distance. Ties go
 * to the branch listed first.
 */
export function chooseBranch(
  children: readonly VesselSpec[],
  parentContinues: boolean,
  rotationDeg: number,
): VesselSpec | null {
  let best: VesselSpec | null = null;
  let bestDiff = Infinity;
  for (const child of children) {
    const diff = angleDiffDeg(rotationDeg, child.branchAngleDeg);
    if (parentContinues && diff > WIRE.branchCaptureDeg) continue;
    if (diff < bestDiff) {
      best = child;
      bestDiff = diff;
    }
  }
  return best;
}

/** Position of the tip along the single rail from the left main ostium, mm (for keeping a balloon behind it). */
export function wirePathS(state: WireState): number | null {
  return state.vessel === null ? null : pathOffsetOf(state.vessel) + state.s;
}

/** The tip is beyond the lesion (in the LAD past its distal end, or in D2). */
export function wireBeyondLesion(state: WireState): boolean {
  return (state.vessel === LESION.vessel && state.s > LESION_END) || state.vessel === 'D2';
}

/** The tip is parked well beyond the lesion in the LAD. */
export function wireParkedDistally(state: WireState): boolean {
  return state.vessel === LESION.vessel && state.s >= LESION_END + WIRE.parkMarginMm;
}

export interface BranchHint {
  readonly distanceMm: number;
  readonly parentContinues: boolean;
  readonly options: readonly { readonly vessel: VesselId; readonly label: string; readonly angleDeg: number }[];
}

/** The next bifurcation within `lookaheadMm`, with the angle each branch needs, or null. */
export function upcomingBranch(state: WireState, lookaheadMm = 25): BranchHint | null {
  if (!state.outOfGuide || state.vessel === null) return null;
  const spec = VESSELS[state.vessel];
  const ahead = childrenOf(state.vessel)
    .filter((c) => c.branchS > state.s + 1e-9)
    .sort((a, b) => a.branchS - b.branchS);
  const first = ahead[0];
  if (!first || first.branchS - state.s > lookaheadMm) return null;
  const here = ahead.filter((c) => c.branchS === first.branchS);
  return {
    distanceMm: first.branchS - state.s,
    parentContinues: spec.length > first.branchS + 1e-9,
    options: here.map((c) => ({ vessel: c.id, label: c.label, angleDeg: c.branchAngleDeg })),
  };
}

function overlapsLesion(fromS: number, toS: number): boolean {
  return Math.min(fromS, toS) <= LESION_END && Math.max(fromS, toS) >= LESION_START;
}

export function stepWire(
  state: WireState,
  input: WireInput,
  context: WireContext,
  dt: number,
  rng: () => number,
): { state: WireState; events: WireEvent[] } {
  const events: WireEvent[] = [];
  let { outOfGuide, vessel, s } = state;
  let { resistance, buckled, dissectionRisk, forcingSeconds, crossingResolved, dissected, warnedEnd } = state;
  const rotationDeg = normalizeDeg(state.rotationDeg + input.rotateRate * dt);
  const v = input.advanceSpeed;

  const startVessel = vessel;
  const startS = s;

  if (v > 0) {
    if (!outOfGuide) {
      if (!context.guideEngaged) {
        events.push({ type: 'needs-engaged-guide' });
      } else {
        outOfGuide = true;
        vessel = 'LM';
        s = 0;
        events.push({ type: 'entered', vessel: 'LM' });
      }
    }
    if (outOfGuide && vessel !== null) {
      let remaining = v * dt;
      while (remaining > 1e-9) {
        const spec: VesselSpec = VESSELS[vessel];
        const branchPoints = childrenOf(vessel)
          .map((c) => c.branchS)
          .filter((b) => b > s + 1e-9)
          .sort((a, b) => a - b);
        const next = branchPoints[0];
        if (next !== undefined && next <= s + remaining + 1e-9) {
          remaining -= next - s;
          s = next;
          const here = childrenOf(vessel).filter((c) => c.branchS === next);
          const chosen = chooseBranch(here, spec.length > next + 1e-9, rotationDeg);
          if (chosen) {
            vessel = chosen.id;
            s = 0;
            warnedEnd = false;
            events.push({ type: 'entered', vessel });
          }
          continue;
        }
        if (s + remaining >= spec.length) {
          s = spec.length;
          remaining = 0;
          events.push({ type: 'vessel-end' });
        } else {
          s += remaining;
          remaining = 0;
        }
      }
      const endSpec = VESSELS[vessel];
      const atDeadEnd = childrenOf(vessel).every((c) => c.branchS <= s);
      if (atDeadEnd && !warnedEnd && s >= endSpec.length - WIRE.endWarningMm && s < endSpec.length) {
        warnedEnd = true;
        events.push({ type: 'near-vessel-end' });
      }
    }
  } else if (v < 0) {
    if (context.balloonOnWire) {
      events.push({ type: 'held-by-balloon' });
    } else if (outOfGuide && vessel !== null) {
      let remaining = -v * dt;
      s -= remaining;
      while (s < 0) {
        const spec: VesselSpec = VESSELS[vessel];
        if (spec.parent === null) {
          outOfGuide = false;
          vessel = null;
          s = 0;
          events.push({ type: 'back-in-guide' });
          break;
        }
        remaining = -s;
        vessel = spec.parent;
        s = spec.branchS - remaining;
        events.push({ type: 'entered', vessel });
      }
      warnedEnd = false;
    }
  }

  // Inside the lesion: pushing past the safe speed buckles the wire and builds hidden risk.
  const inLesionVessel = vessel === LESION.vessel && startVessel === LESION.vessel;
  const touching = inLesionVessel && overlapsLesion(startS, s);
  if (touching && v > 0) {
    const safe = safeSpeed(input.rotateRate);
    const excess = Math.max(0, v / safe - 1);
    resistance = Math.min(1, v / (2 * safe));
    if (excess > 0) {
      if (!buckled) events.push({ type: 'buckling' });
      buckled = true;
      forcingSeconds += dt;
      dissectionRisk = Math.min(WIRE.maxRisk, dissectionRisk + WIRE.riskPerSecondPerExcess * excess * dt);
    } else {
      buckled = false;
    }
  } else if (!touching) {
    resistance = 0;
    buckled = false;
  }

  // Crossing the lesion's distal end: one roll against the risk built up.
  if (inLesionVessel && startS <= LESION_END && s > LESION_END && !crossingResolved) {
    crossingResolved = true;
    if (!dissected && rng() < dissectionRisk) {
      dissected = true;
      events.push({ type: 'dissection', s: LESION.centreS });
    } else {
      events.push({ type: 'crossed' });
    }
  }
  // Pulled back proximal to the lesion, a later crossing is a new attempt.
  if (crossingResolved && !(vessel === LESION.vessel && s > LESION_START) && vessel !== 'D2' && vessel !== null) {
    crossingResolved = false;
  }
  if (!outOfGuide) crossingResolved = false;

  return {
    state: {
      outOfGuide, vessel, s, rotationDeg, resistance, buckled, dissectionRisk,
      forcingSeconds, crossingResolved, dissected, warnedEnd,
    },
    events,
  };
}

export function describeWireEvent(event: WireEvent): string {
  switch (event.type) {
    case 'needs-engaged-guide':
      return 'Engage the guide in the left main before advancing the wire.';
    case 'held-by-balloon':
      return 'The wire cannot be pulled back while a balloon is on it.';
    case 'entered':
      return `The wire has entered the ${VESSELS[event.vessel].label.toLowerCase()}.`;
    case 'back-in-guide':
      return 'The wire is back inside the guide.';
    case 'buckling':
      return 'The wire is buckling: you are pushing too hard against the blockage. Slow down, or spin the wire as you advance.';
    case 'crossed':
      return 'The wire has crossed the lesion.';
    case 'dissection':
      return 'The wire has caused a dissection. Flow beyond it is reduced until a stent covers it.';
    case 'near-vessel-end':
      return 'The wire tip is near the end of the vessel: pushing on risks perforation. Hold here.';
    case 'vessel-end':
      return 'The wire is at the end of the vessel and cannot go further.';
  }
}
