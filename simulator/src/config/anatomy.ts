/**
 * Every anatomy size, device size and physiology constant in one place.
 * Units: 1 scene unit = 1 mm. Pressures in atm, times in seconds, angles in degrees.
 *
 * These are TEACHING APPROXIMATIONS chosen so the simulator behaves plausibly and the
 * debrief has something to teach. They are not clinical reference values, thresholds or
 * guidance, and must not be read as such.
 */

// --- coronary tree ---------------------------------------------------------------

export type VesselId = 'LM' | 'LAD' | 'LCx' | 'D1' | 'D2' | 'RCA';

export interface VesselSpec {
  readonly id: VesselId;
  readonly label: string;
  /** Centreline length, mm. */
  readonly length: number;
  /** The vessel this one leaves (null: arises from the aortic root). */
  readonly parent: VesselId | null;
  /** Arc position on the parent where this vessel leaves, mm. */
  readonly branchS: number;
  /**
   * Wire-tip rotation that selects this branch at its bifurcation, degrees. At a
   * bifurcation with a continuing parent, a branch is only entered if the tip is within
   * WIRE.branchCaptureDeg of this angle; where the parent ends, the nearest angle wins.
   */
  readonly branchAngleDeg: number;
  /** Reference (healthy) lumen diameter at the start and end of the vessel, mm; linear in between. */
  readonly diameterProximal: number;
  readonly diameterDistal: number;
}

export const VESSELS: Readonly<Record<VesselId, VesselSpec>> = {
  LM: { id: 'LM', label: 'Left main', length: 12, parent: null, branchS: 0, branchAngleDeg: 0, diameterProximal: 4.2, diameterDistal: 4.0 },
  LAD: { id: 'LAD', label: 'Left anterior descending', length: 110, parent: 'LM', branchS: 12, branchAngleDeg: -45, diameterProximal: 3.8, diameterDistal: 1.9 },
  LCx: { id: 'LCx', label: 'Left circumflex', length: 75, parent: 'LM', branchS: 12, branchAngleDeg: 20, diameterProximal: 3.4, diameterDistal: 1.8 },
  D1: { id: 'D1', label: 'First diagonal', length: 55, parent: 'LAD', branchS: 30, branchAngleDeg: 70, diameterProximal: 2.6, diameterDistal: 1.4 },
  D2: { id: 'D2', label: 'Second diagonal', length: 45, parent: 'LAD', branchS: 70, branchAngleDeg: -70, diameterProximal: 2.2, diameterDistal: 1.2 },
  RCA: { id: 'RCA', label: 'Right coronary artery', length: 120, parent: null, branchS: 0, branchAngleDeg: 0, diameterProximal: 3.6, diameterDistal: 2.2 },
};

/** The vessels filled by a selective injection with the guide engaged in the left main. */
export const LEFT_SYSTEM: readonly VesselId[] = ['LM', 'LAD', 'LCx', 'D1', 'D2'];

/** Order such that a vessel always comes after its parent. */
export const VESSEL_ORDER: readonly VesselId[] = ['LM', 'LAD', 'LCx', 'D1', 'D2', 'RCA'];

// --- the lesion ---------------------------------------------------------------------

export const LESION = {
  vessel: 'LAD' as VesselId,
  /** Between D1 (s = 30) and D2 (s = 70). */
  centreS: 48,
  length: 14,
  /** Length of the flat, narrowest part in the middle; the rest is a cosine taper to the ends. */
  plateau: 4,
  /** Diameter stenosis at the narrowest point, as a fraction (0.9 = 90%). */
  diameterStenosis: 0.9,
} as const;

export const LESION_START = LESION.centreS - LESION.length / 2;
export const LESION_END = LESION.centreS + LESION.length / 2;

// --- access route (right radial to the aortic root), one rail ----------------------

export const ROUTE_SEGMENTS = [
  { id: 'radial', label: 'Right radial artery', length: 250 },
  { id: 'brachial', label: 'Brachial artery', length: 270 },
  { id: 'axillary', label: 'Axillary artery', length: 100 },
  { id: 'subclavian', label: 'Right subclavian artery', length: 60 },
  { id: 'brachiocephalic', label: 'Brachiocephalic trunk', length: 40 },
  { id: 'aorta', label: 'Aortic arch and ascending aorta', length: 110 },
] as const;

/** The elbow, where the radial artery ends and the brachial begins. */
export const ELBOW_S = 250;
/** Where the brachiocephalic trunk ends and the aorta begins. */
export const AORTA_ENTRY_S = 250 + 270 + 100 + 60 + 40;
/** The aortic root, where the guide stops. */
export const AORTIC_ROOT_S = AORTA_ENTRY_S + 110;
/** How far past the elbow the guide must be to count as "past the elbow". */
export const PAST_ELBOW_MARGIN = 10;

// --- guide catheter (6F) and guidewire (0.014") ------------------------------------

export const GUIDE = {
  frenchSize: 6,
  /** Tip direction that faces each aortic cusp, degrees. Start orientation is 0. */
  leftCuspAngleDeg: 60,
  rightCuspAngleDeg: -60,
  nonCoronaryAngleDeg: 180,
  /** Engagement needs the tip within this of the left cusp direction. */
  engageWindowDeg: 25,
  /** Once engaged, turning further than this from the left cusp direction pops the guide out. */
  popOutTorqueDeg: 40,
  /** Advancing faster than this at the root bounces rather than seats. */
  gentleAdvanceSpeed: 15,
  /** Gentle advance needed at the root with the correct orientation to seat in the ostium. */
  seatDistance: 4,
  advanceSpeed: 80,
  fineAdvanceSpeed: 12,
  rotateRate: 60,
} as const;

export const WIRE = {
  diameterMm: 0.356,
  /** Advancing faster than this inside the lesion buckles the wire and risks dissection. */
  safeSpeed: 8,
  /** Fully spinning the wire raises the safe speed by this fraction. */
  torqueSafeSpeedGain: 1.0,
  /** Rotation rate that counts as fully spinning, deg/s. */
  spinReferenceRate: 90,
  /** A branch is entered only if the tip is within this of its angle (where the parent continues). */
  branchCaptureDeg: 50,
  /** Dissection risk gained per second at 100% over the safe speed. */
  riskPerSecondPerExcess: 0.35,
  maxRisk: 0.9,
  /** Within this of a vessel's distal end the user is warned of perforation risk. */
  endWarningMm: 6,
  /** To count as parked distally the tip must be this far past the lesion end. */
  parkMarginMm: 20,
  advanceSpeed: 25,
  fineAdvanceSpeed: 6,
  rotateRate: 90,
} as const;

// --- balloon and stent catheters -----------------------------------------------------

export const BALLOON = {
  diameters: [2.0, 2.5, 3.0, 3.5],
  lengths: [12, 15, 20],
  nominalAtm: 8,
  ratedBurstAtm: 14,
  /** Fractional diameter change per atm around nominal. */
  compliancePerAtm: 0.015,
  ruptureMarginAtm: 4,
} as const;

export const STENT = {
  diameters: [2.5, 2.75, 3.0, 3.5, 4.0],
  lengths: [12, 15, 18, 23, 28],
  nominalAtm: 10,
  ratedBurstAtm: 16,
  compliancePerAtm: 0.012,
  ruptureMarginAtm: 4,
  /** The stent becomes deployed (permanent) once the balloon reaches this pressure. */
  deployAtm: 6,
  /** Elastic recoil after deployment. */
  recoil: 0.03,
} as const;

export const INFLATION = {
  /** Below this the balloon is still unfolding and is smaller than its compliance curve says. */
  unfoldAtm: 2,
  /** Diameter of the folded balloon at 0 atm, mm. */
  foldedDiameter: 0.9,
  /** Counts as inflated (cannot move, timer runs) at or above this. */
  inflatedAtm: 1,
  inflateRateAtmPerS: 3,
  fineInflateRateAtmPerS: 0.5,
  deflateRateAtmPerS: 6,
  /** Pre-dilation counts only at or above this. */
  predilateMinAtm: 6,
} as const;

/** What the vessel does after a balloon or stent. */
export const LUMEN = {
  /** A plain balloon leaves the lumen open, minus this fraction of the achieved diameter. */
  balloonRecoil: 0.3,
  /** Smooth taper at the ends of a treated segment, mm. */
  edgeTaperMm: 1.0,
  /** Over-sizing beyond this ratio of the reference diameter causes a dissection. */
  oversizeRatio: 1.2,
  /** An oversized stent's edge dissection sits this far beyond its distal end, mm. */
  edgeDissectionOffsetMm: 1.5,
} as const;

/** A balloon this fraction of the local reference diameter, or larger, seals the vessel. */
export const BALLOON_OCCLUSION_FRACTION = 0.8;

// --- flow and contrast -----------------------------------------------------------------

export const FLOW = {
  /** Spacing of the contrast "rings" along each vessel, mm. */
  ringSpacing: 2,
  /** Contrast speed in an unobstructed coronary, mm/s. */
  baseSpeed: 60,
  /** Below this diameter stenosis flow is unaffected. */
  fullFlowBelowDs: 0.6,
  /** At or above this diameter stenosis there is no flow. */
  noFlowAtDs: 0.98,
  /** Steepness of the fall between the two. */
  falloffExponent: 2.5,
  timi3At: 0.8,
  timi2At: 0.25,
  timi1Above: 0.02,
  /** Multiplier on downstream flow from an unsealed dissection. */
  dissectionFactor: 0.45,
  washoutSeconds: 2.5,
  minCineSeconds: 3,
  maxCineSeconds: 14,
} as const;

export const CONTRAST = {
  selectiveMl: 8,
  aorticMl: 20,
} as const;

// --- patient physiology and monitor ---------------------------------------------------------

export const PHYSIOLOGY = {
  baseHr: 72,
  baseSystolic: 128,
  baseDiastolic: 76,
  baseSpo2: 98,
  baseActSeconds: 128,
  targetActSeconds: 285,
  /** Time constant of the ACT rise after heparin, s. */
  actTauSeconds: 15,
  /** Seconds of total occlusion for the ischaemia to reach its maximum. */
  ischaemiaRiseSeconds: 20,
  ischaemiaRecoveryTauSeconds: 8,
  maxStElevationMm: 4,
  hrRiseAtMaxIschaemia: 28,
  /** Flow below this starts to cause ischaemia; at or below `occludedBelow` it is complete. */
  poorFlowBelow: 0.25,
  occludedBelow: 0.02,
  bpDropAfterSeconds: 40,
  bpDropPerSecond: 2.25,
  maxBpDrop: 45,
  pvcAfterSeconds: 40,
  unstableAfterSeconds: 60,
  chestPainIschaemia: 0.35,
  /** Standard ECG scaling: 1 mm of ST elevation = 0.1 mV. */
  mvPerMm: 0.1,
} as const;

// --- fluoroscopy ----------------------------------------------------------------------------

export const FLUORO = {
  frameRate: 15,
} as const;

export interface CArmPreset {
  readonly id: string;
  readonly label: string;
  /** Positive = left anterior oblique (LAO), negative = right anterior oblique (RAO). */
  readonly laoDeg: number;
  /** Positive = cranial, negative = caudal. */
  readonly cranialDeg: number;
}

export const CARM_PRESETS: readonly CArmPreset[] = [
  { id: 'RAO30_CRA30', label: 'RAO 30 CRA 30', laoDeg: -30, cranialDeg: 30 },
  { id: 'AP_CRA35', label: 'AP CRA 35', laoDeg: 0, cranialDeg: 35 },
  { id: 'LAO45_CRA30', label: 'LAO 45 CRA 30', laoDeg: 45, cranialDeg: 30 },
  { id: 'LAO45_CAU30', label: 'LAO 45 CAU 30 (spider)', laoDeg: 45, cranialDeg: -30 },
  { id: 'RAO30_CAU25', label: 'RAO 30 CAU 25', laoDeg: -30, cranialDeg: -25 },
  { id: 'AP', label: 'AP', laoDeg: 0, cranialDeg: 0 },
];

// --- debrief thresholds ------------------------------------------------------------------------

export const DEBRIEF = {
  residualStenosisOk: 0.1,
  residualStenosisWarn: 0.3,
  stentRatioOk: [0.95, 1.15] as const,
  stentRatioWarn: [0.85, 1.2] as const,
  coverageMarginOkMm: 1.5,
  longestInflationOkS: 30,
  longestInflationWarnS: 60,
  contrastOkMl: 120,
  contrastWarnMl: 180,
  fluoroOkMinutes: 10,
  fluoroWarnMinutes: 15,
  /** Up to this long past the safe speed is treated as a transient, not forcing. */
  forcingOkSeconds: 0.5,
  forcingWarnSeconds: 3,
  minFinalViews: 2,
  gradeExcellentAt: 90,
  gradeGoodAt: 75,
  gradeAcceptableAt: 60,
} as const;

// --- helpers over the tables above ---------------------------------------------------------------

/** Offset of a vessel's start along the single rail from the left main ostium, mm. */
export function pathOffsetOf(vessel: VesselId): number {
  const spec = VESSELS[vessel];
  return spec.parent === null ? 0 : pathOffsetOf(spec.parent) + spec.branchS;
}

/** Vessels whose parent is `parent`, in tree order. */
export function childrenOf(parent: VesselId): VesselSpec[] {
  return VESSEL_ORDER.map((id) => VESSELS[id]).filter((spec) => spec.parent === parent);
}

/** Rules that apply to any catheter riding over the wire. */
export const CATHETER = {
  /** The balloon or stent's distal end must stay at least this far behind the wire tip, mm. */
  clearanceBehindWireMm: 1,
  /** A balloon must overlap at least this fraction of the lesion to count as "across" it. */
  acrossLesionFraction: 0.8,
} as const;
