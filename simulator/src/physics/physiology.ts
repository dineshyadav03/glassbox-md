/**
 * The patient: ischaemia driven by flow in the LAD, the vitals that follow from it, and the
 * anticoagulation (ACT) after heparin. Pure functions over plain data.
 *
 * A teaching model of "block the artery and the patient gets worse, open it and they
 * recover", with invented time constants. It is not a physiological simulation.
 */
import { PHYSIOLOGY } from '../config/anatomy';

export interface PhysiologyState {
  /** 0 = none, 1 = maximal. */
  readonly ischaemia: number;
  /** Continuous seconds of complete occlusion; resets to 0 as soon as any flow returns. */
  readonly occludedSeconds: number;
  readonly heparinGiven: boolean;
  /** Activated clotting time, seconds. */
  readonly actSeconds: number;
}

export const INITIAL_PHYSIOLOGY: PhysiologyState = {
  ischaemia: 0,
  occludedSeconds: 0,
  heparinGiven: false,
  actSeconds: PHYSIOLOGY.baseActSeconds,
};

/** How ischaemic the territory wants to be at this LAD flow factor: 0 at TIMI 2 or better, 1 when occluded. */
export function ischaemiaSeverity(flowFactor: number): number {
  const span = PHYSIOLOGY.poorFlowBelow - PHYSIOLOGY.occludedBelow;
  return Math.min(1, Math.max(0, (PHYSIOLOGY.poorFlowBelow - flowFactor) / span));
}

/**
 * Advance by `dt` seconds. Ischaemia climbs linearly (about 20 s to full) toward the severity
 * the flow demands, and recovers exponentially (time constant about 8 s) once flow returns.
 */
export function stepPhysiology(state: PhysiologyState, ladFlowFactor: number, dt: number): PhysiologyState {
  const target = ischaemiaSeverity(ladFlowFactor);
  let ischaemia = state.ischaemia;
  if (target > ischaemia) {
    ischaemia = Math.min(target, ischaemia + dt / PHYSIOLOGY.ischaemiaRiseSeconds);
  } else {
    ischaemia += (target - ischaemia) * (1 - Math.exp(-dt / PHYSIOLOGY.ischaemiaRecoveryTauSeconds));
  }

  const occludedSeconds = ladFlowFactor <= PHYSIOLOGY.occludedBelow ? state.occludedSeconds + dt : 0;

  let actSeconds = state.actSeconds;
  if (state.heparinGiven) {
    actSeconds += (PHYSIOLOGY.targetActSeconds - actSeconds) * (1 - Math.exp(-dt / PHYSIOLOGY.actTauSeconds));
  }

  return { ...state, ischaemia, occludedSeconds, actSeconds };
}

/** Heparin is given once; giving it again changes nothing. */
export function giveHeparin(state: PhysiologyState): PhysiologyState {
  return state.heparinGiven ? state : { ...state, heparinGiven: true };
}

export interface Vitals {
  readonly heartRate: number;
  readonly systolic: number;
  readonly diastolic: number;
  readonly spo2: number;
  /** ST elevation in V2, mm. */
  readonly stMm: number;
  readonly pvc: boolean;
  readonly unstable: boolean;
  readonly chestPain: boolean;
  readonly alarm: boolean;
  readonly message: string | null;
  readonly actSeconds: number;
}

export function vitalsOf(state: PhysiologyState): Vitals {
  const { occludedSeconds, ischaemia } = state;
  const pvc = occludedSeconds > PHYSIOLOGY.pvcAfterSeconds;
  const unstable = occludedSeconds > PHYSIOLOGY.unstableAfterSeconds;
  const chestPain = ischaemia > PHYSIOLOGY.chestPainIschaemia;

  const bpDrop =
    occludedSeconds > PHYSIOLOGY.bpDropAfterSeconds
      ? Math.min(PHYSIOLOGY.maxBpDrop, (occludedSeconds - PHYSIOLOGY.bpDropAfterSeconds) * PHYSIOLOGY.bpDropPerSecond)
      : 0;
  const systolic = PHYSIOLOGY.baseSystolic - bpDrop;
  const diastolic = PHYSIOLOGY.baseDiastolic - 0.55 * bpDrop;
  const spo2 = PHYSIOLOGY.baseSpo2 - (unstable ? Math.min(6, (occludedSeconds - PHYSIOLOGY.unstableAfterSeconds) * 0.3) : 0);

  let message: string | null = null;
  if (unstable) message = 'Patient is unstable. Deflate now.';
  else if (chestPain) message = 'The patient reports chest pain.';

  return {
    heartRate: PHYSIOLOGY.baseHr + PHYSIOLOGY.hrRiseAtMaxIschaemia * ischaemia + (unstable ? 15 : 0),
    systolic,
    diastolic,
    spo2,
    stMm: PHYSIOLOGY.maxStElevationMm * ischaemia,
    pvc,
    unstable,
    chestPain,
    alarm: unstable,
    message,
    actSeconds: state.actSeconds,
  };
}
