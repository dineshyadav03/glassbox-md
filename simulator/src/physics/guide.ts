/**
 * The 6F guide catheter on the 1D access rail: it advances from the wrist to the aortic
 * root and stops there; its pre-shaped tip must face the left coronary cusp to seat in the
 * left main ostium. Pure functions over plain data. Units: mm, degrees, seconds.
 */
import {
  AORTA_ENTRY_S,
  AORTIC_ROOT_S,
  ELBOW_S,
  GUIDE,
  PAST_ELBOW_MARGIN,
} from '../config/anatomy';
import { angleDiffDeg, normalizeDeg } from './angles';

export interface GuideState {
  /** Distance of the tip from the wrist along the access route. */
  readonly s: number;
  /** Which way the shaped tip points, degrees. 0 is the neutral orientation. */
  readonly rotationDeg: number;
  /** Seated in the left main ostium. */
  readonly engaged: boolean;
  /** Gentle advance accumulated at the root toward seating, mm. */
  readonly seatProgress: number;
}

export interface GuideInput {
  /** Signed speed along the rail, mm/s (positive advances). */
  readonly advanceSpeed: number;
  /** Signed rotation rate, degrees per second. */
  readonly rotateRate: number;
}

export interface GuideContext {
  /** The wire is out of the guide tip. */
  readonly wireOut: boolean;
}

export type Cusp = 'right' | 'non-coronary' | 'none';

export type GuideEvent =
  | { readonly type: 'engaged' }
  | { readonly type: 'disengaged' }
  | { readonly type: 'popped-out' }
  | { readonly type: 'wrong-cusp'; readonly cusp: Cusp }
  | { readonly type: 'too-fast' }
  | { readonly type: 'locked-by-wire' };

export function createGuide(): GuideState {
  return { s: 0, rotationDeg: 0, engaged: false, seatProgress: 0 };
}

/** What the tip is facing, apart from the left cusp. */
export function otherCuspFacing(rotationDeg: number): Cusp {
  if (angleDiffDeg(rotationDeg, GUIDE.rightCuspAngleDeg) <= GUIDE.engageWindowDeg) return 'right';
  if (angleDiffDeg(rotationDeg, GUIDE.nonCoronaryAngleDeg) <= GUIDE.engageWindowDeg) return 'non-coronary';
  return 'none';
}

/** Is the tip within the engagement window of the left coronary cusp? */
export function facesLeftCusp(rotationDeg: number): boolean {
  return angleDiffDeg(rotationDeg, GUIDE.leftCuspAngleDeg) <= GUIDE.engageWindowDeg;
}

export function guideCheckpoints(s: number): { pastElbow: boolean; inAorta: boolean; atRoot: boolean } {
  return {
    pastElbow: s >= ELBOW_S + PAST_ELBOW_MARGIN,
    inAorta: s >= AORTA_ENTRY_S,
    atRoot: s >= AORTIC_ROOT_S - 0.5,
  };
}

export function stepGuide(
  state: GuideState,
  input: GuideInput,
  context: GuideContext,
  dt: number,
): { state: GuideState; events: GuideEvent[] } {
  const events: GuideEvent[] = [];
  let { s, engaged, seatProgress } = state;
  const rotationDeg = normalizeDeg(state.rotationDeg + input.rotateRate * dt);
  const v = input.advanceSpeed;

  if (v !== 0 && context.wireOut) {
    events.push({ type: 'locked-by-wire' });
  } else if (v < 0) {
    if (engaged) {
      engaged = false;
      events.push({ type: 'disengaged' });
    }
    seatProgress = 0;
    s = Math.max(0, s + v * dt);
  } else if (v > 0 && !engaged) {
    const wanted = s + v * dt;
    if (wanted <= AORTIC_ROOT_S) {
      s = wanted;
    } else {
      const push = wanted - AORTIC_ROOT_S;
      s = AORTIC_ROOT_S;
      if (v > GUIDE.gentleAdvanceSpeed) {
        seatProgress = 0;
        events.push({ type: 'too-fast' });
      } else if (facesLeftCusp(rotationDeg)) {
        seatProgress += push;
        if (seatProgress >= GUIDE.seatDistance) {
          engaged = true;
          events.push({ type: 'engaged' });
        }
      } else {
        seatProgress = 0;
        events.push({ type: 'wrong-cusp', cusp: otherCuspFacing(rotationDeg) });
      }
    }
  }

  if (engaged && angleDiffDeg(rotationDeg, GUIDE.leftCuspAngleDeg) > GUIDE.popOutTorqueDeg) {
    engaged = false;
    seatProgress = 0;
    events.push({ type: 'popped-out' });
  }

  return { state: { s, rotationDeg, engaged, seatProgress }, events };
}

/** A calm, specific sentence for the mentor panel. */
export function describeGuideEvent(event: GuideEvent): string {
  switch (event.type) {
    case 'engaged':
      return 'The guide is seated in the left main.';
    case 'disengaged':
      return 'The guide has come out of the left main.';
    case 'popped-out':
      return 'Too much torque: the guide popped out of the left main. Turn back toward the left cusp and seat it gently.';
    case 'too-fast':
      return 'Advance gently to seat the guide; pushing fast bounces it off the ostium.';
    case 'locked-by-wire':
      return 'The guide cannot move while the wire is out. Pull the wire back into the guide first.';
    case 'wrong-cusp':
      if (event.cusp === 'right') {
        return 'The tip is facing the right coronary cusp, where the right coronary artery arises. Rotate toward the left cusp.';
      }
      if (event.cusp === 'non-coronary') {
        return 'The tip is facing the non-coronary cusp, which has no artery. Rotate toward the left cusp.';
      }
      return 'The tip is not facing a coronary cusp. Rotate it toward the left cusp before advancing.';
  }
}
