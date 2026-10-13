/**
 * What each panel of the lab screen shows, as plain data computed from the simulation. The DOM code
 * only draws these, so the content (which tool is locked and why, which stage task is next, what the
 * gauge reads) is unit tested without a browser.
 */
import { AORTIC_ROOT_S, BALLOON, ELBOW_S, GUIDE, INFLATION, LESION, STENT, WIRE, type VesselId } from '../config/anatomy';
import { availability, currentCArm, hintOf, stageIndexOf, treatmentsOf, type MovableTool, type Simulation } from '../engine/simulation';
import { vitalsOf } from '../physics/physiology';
import { upcomingBranch } from '../physics/wire';
import { STAGES, TOOL_ORDER, type ToolId } from '../procedure/stages';
import { inflatedDiameter, isInflated, lesionCoverage, type Catheter, type CatheterKind } from '../tools/devices';

// --- tool bar ------------------------------------------------------------------------------------------

export interface ToolButton {
  readonly id: ToolId;
  readonly key: string;
  readonly label: string;
  /** select: chooses the tool moved by the keys; action: does something once; hold: acts while held. */
  readonly kind: 'select' | 'action' | 'hold';
  readonly available: boolean;
  readonly reason: string | null;
  readonly active: boolean;
}

const TOOL_LABEL: Readonly<Record<ToolId, string>> = {
  guide: 'Guide',
  wire: 'Wire',
  balloon: 'Balloon',
  stent: 'Stent',
  contrast: 'Contrast',
  fluoro: 'Fluoro',
  measure: 'Measure',
};

const TOOL_KIND: Readonly<Record<ToolId, ToolButton['kind']>> = {
  guide: 'select',
  wire: 'select',
  balloon: 'select',
  stent: 'select',
  contrast: 'action',
  fluoro: 'hold',
  measure: 'action',
};

export function toolButtons(sim: Simulation): ToolButton[] {
  return TOOL_ORDER.map((id, index) => {
    const a = availability(sim, id);
    return {
      id,
      key: String(index + 1),
      label: TOOL_LABEL[id],
      kind: TOOL_KIND[id],
      available: a.available,
      reason: a.reason,
      active: TOOL_KIND[id] === 'select' && sim.tool === id,
    };
  });
}

// --- the stage panel -----------------------------------------------------------------------------------------

export interface TaskView {
  readonly label: string;
  readonly done: boolean;
  /** The first task still to do in the current stage. */
  readonly next: boolean;
}

export interface StageView {
  /** 1-based; STAGES.length + 1 when the case is finished. */
  readonly number: number;
  readonly total: number;
  readonly title: string;
  readonly goal: string;
  readonly why: string;
  readonly tasks: readonly TaskView[];
  readonly hint: string;
  /** Share of all sub-tasks done, 0 to 1. */
  readonly overall: number;
  readonly finished: boolean;
}

export function stageView(sim: Simulation): StageView {
  const index = stageIndexOf(sim);
  const stage = STAGES[index];
  const all = STAGES.flatMap((s) => s.subtasks);
  const doneCount = all.filter((t) => sim.progress.latched[t.id]).length;
  if (!stage) {
    return { number: STAGES.length + 1, total: STAGES.length, title: 'All steps complete', goal: '', why: '', tasks: [], hint: hintOf(sim), overall: 1, finished: true };
  }
  const firstUndone = stage.subtasks.findIndex((t) => !sim.progress.latched[t.id]);
  return {
    number: index + 1,
    total: STAGES.length,
    title: stage.title,
    goal: stage.goal,
    why: stage.why,
    tasks: stage.subtasks.map((t, i) => ({ label: t.label, done: Boolean(sim.progress.latched[t.id]), next: i === firstUndone })),
    hint: hintOf(sim),
    overall: doneCount / all.length,
    finished: false,
  };
}

/** One row of the checklist of all six steps, with when each was finished. */
export interface StageRow {
  readonly number: number;
  readonly title: string;
  readonly done: boolean;
  readonly current: boolean;
  /** Case time it was completed at, like "1:42", or an empty string. */
  readonly time: string;
}

export function stageList(sim: Simulation): StageRow[] {
  const current = stageIndexOf(sim);
  return STAGES.map((stage, i) => {
    const at = sim.progress.completedAt[i] ?? null;
    return { number: i + 1, title: stage.title, done: at !== null, current: i === current, time: at === null ? '' : timeString(at) };
  });
}

/** The newest mentor message while it is fresh, for the strip above the toolbar. */
export interface Toast {
  readonly text: string;
  readonly level: 'info' | 'good' | 'warn' | 'bad';
}

export const TOAST_SECONDS = 4;

export function toastView(sim: Simulation): Toast | null {
  const last = sim.messages[sim.messages.length - 1];
  if (!last || sim.time - last.t > TOAST_SECONDS) return null;
  return { text: last.text, level: last.level };
}

/** Fluoroscopy time and contrast used so far, for the top bar. */
export function usageReadout(sim: Simulation): { readonly fluoro: string; readonly contrast: string } {
  return { fluoro: timeString(sim.fluoroSeconds), contrast: `${Math.round(sim.contrastMl)} ml` };
}

// --- the monitor ----------------------------------------------------------------------------------------------

export interface MonitorView {
  readonly heartRate: number;
  readonly bp: string;
  readonly spo2: number;
  readonly actSeconds: number;
  readonly stMm: number;
  readonly pvc: boolean;
  readonly message: string | null;
  readonly alarm: boolean;
  /** 0 to 1, for tinting the trace when ischaemic. */
  readonly ischaemia: number;
}

export function monitorView(sim: Simulation): MonitorView {
  const v = vitalsOf(sim.patient);
  return {
    heartRate: Math.round(v.heartRate),
    bp: `${Math.round(v.systolic)}/${Math.round(v.diastolic)}`,
    spo2: Math.round(v.spo2),
    actSeconds: Math.round(v.actSeconds),
    stMm: Math.round(v.stMm * 10) / 10,
    pvc: v.pvc,
    message: v.message,
    alarm: v.alarm,
    ischaemia: sim.patient.ischaemia,
  };
}

// --- the tip dial ----------------------------------------------------------------------------------------------

export interface DialTarget {
  readonly label: string;
  readonly angleDeg: number;
  /** The one the learner usually wants. */
  readonly wanted: boolean;
}

export interface DialView {
  readonly title: string;
  readonly angleDeg: number;
  readonly targets: readonly DialTarget[];
  /** Half-width of the acceptance window around the wanted target, if any. */
  readonly windowDeg: number | null;
}

export function dialView(sim: Simulation): DialView | null {
  if (sim.tool === 'guide') {
    return {
      title: 'Guide tip',
      angleDeg: sim.guide.rotationDeg,
      targets: [
        { label: 'Left cusp', angleDeg: GUIDE.leftCuspAngleDeg, wanted: true },
        { label: 'Right cusp', angleDeg: GUIDE.rightCuspAngleDeg, wanted: false },
        { label: 'Non-coronary', angleDeg: GUIDE.nonCoronaryAngleDeg, wanted: false },
      ],
      windowDeg: GUIDE.engageWindowDeg,
    };
  }
  if (sim.tool === 'wire') {
    const hint = upcomingBranch(sim.wire);
    const targets: DialTarget[] = hint
      ? hint.options.map((o) => ({ label: o.vessel, angleDeg: o.angleDeg, wanted: o.vessel === LESION.vessel }))
      : [];
    return { title: 'Wire tip', angleDeg: sim.wire.rotationDeg, targets, windowDeg: hint && hint.parentContinues ? WIRE.branchCaptureDeg : null };
  }
  return null;
}

// --- readouts --------------------------------------------------------------------------------------------------------

export function timeString(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const VESSEL_NAME: Readonly<Record<VesselId, string>> = {
  LM: 'left main',
  LAD: 'LAD',
  LCx: 'circumflex',
  D1: 'first diagonal',
  D2: 'second diagonal',
  RCA: 'right coronary',
};

export function positionReadout(sim: Simulation): string {
  switch (sim.tool) {
    case 'guide': {
      const s = Math.round(sim.guide.s);
      if (sim.guide.engaged) return `Guide seated in the left main (${s} mm from the wrist).`;
      if (sim.guide.s >= AORTIC_ROOT_S - 0.5) return `Guide at the aortic root (${s} mm). Tip ${Math.round(sim.guide.rotationDeg)}°.`;
      const where = sim.guide.s < ELBOW_S ? 'in the radial artery' : sim.guide.s < 520 ? 'in the brachial artery' : 'past the shoulder';
      return `Guide ${s} mm from the wrist, ${where}.`;
    }
    case 'wire': {
      const w = sim.wire;
      if (!w.outOfGuide || w.vessel === null) return 'Wire is inside the guide. Advance it into the left main.';
      return `Wire tip ${w.s.toFixed(1)} mm into the ${VESSEL_NAME[w.vessel]}. Tip ${Math.round(w.rotationDeg)}°.`;
    }
    case 'balloon':
    case 'stent': {
      const c = sim.tool === 'balloon' ? sim.balloon : sim.stent;
      if (c.deployed) return 'Stent deployed. Withdraw its delivery catheter, or load a fresh stent.';
      if (c.ruptured) return 'This balloon has ruptured. Withdraw it to load a fresh one.';
      if (c.inGuide || c.centreS === null) return `${sizeLabel(c)} is in the guide. Advance it over the wire.`;
      return `${sizeLabel(c)} centred ${c.centreS.toFixed(1)} mm along the LAD.`;
    }
  }
}

export function sizeLabel(c: Catheter): string {
  return `${c.spec.kind === 'balloon' ? 'Balloon' : 'Stent'} ${c.spec.diameter} x ${c.spec.length} mm`;
}

/** How the stent sits against the lesion right now, or null if it is not in the artery. */
export function coverageReadout(sim: Simulation): string | null {
  const stents = treatmentsOf(sim).filter((t) => t.kind === 'stent');
  const centre = stents[0]?.centreS ?? (!sim.stent.inGuide ? sim.stent.centreS : null);
  const length = stents[0]?.length ?? sim.stent.spec.length;
  if (centre === null) return null;
  const c = lesionCoverage(centre, length);
  if (c.coversLesion) return `Covers the lesion: ${c.proximalMarginMm.toFixed(1)} mm past it proximally, ${c.distalMarginMm.toFixed(1)} mm distally.`;
  return `Does not yet cover the lesion (${c.proximalMarginMm.toFixed(1)} mm proximal, ${c.distalMarginMm.toFixed(1)} mm distal margin).`;
}

export function qcaReadout(sim: Simulation): string | null {
  if (!sim.qca) return null;
  return `Reference ${sim.qca.referenceDiameterMm.toFixed(2)} mm, lesion ${sim.qca.lesionLengthMm} mm, ${Math.round(sim.qca.stenosis * 100)}% stenosis.`;
}

export function carmReadout(sim: Simulation): string {
  return currentCArm(sim).label;
}

// --- the pressure gauge ----------------------------------------------------------------------------------------------

export type GaugeState = 'in-guide' | 'folded' | 'inflated' | 'over-rated' | 'ruptured' | 'deployed';

export interface GaugeView {
  readonly pressure: number;
  /** Top of the scale, atm. */
  readonly max: number;
  readonly nominal: number;
  readonly rated: number;
  readonly rupture: number;
  readonly deployAt: number | null;
  readonly diameterMm: number;
  readonly state: GaugeState;
  /** Seconds the current inflation has been up. */
  readonly runSeconds: number;
  readonly label: string;
}

export function gaugeView(c: Catheter): GaugeView {
  const { spec } = c;
  let state: GaugeState = 'folded';
  if (c.ruptured) state = 'ruptured';
  else if (c.inGuide && !c.deployed) state = 'in-guide';
  else if (c.pressure > spec.ratedBurstAtm) state = 'over-rated';
  else if (isInflated(c)) state = c.deployed ? 'deployed' : 'inflated';
  else if (c.deployed) state = 'deployed';
  return {
    pressure: c.pressure,
    max: Math.ceil(spec.ruptureAtm) + 2,
    nominal: spec.nominalAtm,
    rated: spec.ratedBurstAtm,
    rupture: spec.ruptureAtm,
    deployAt: spec.kind === 'stent' ? STENT.deployAtm : null,
    diameterMm: inflatedDiameter(spec, c.pressure),
    state,
    runSeconds: c.current?.elapsedS ?? 0,
    label: sizeLabel(c),
  };
}

export interface SizeOptions {
  readonly diameters: readonly number[];
  readonly lengths: readonly number[];
}

export function sizeOptions(kind: CatheterKind): SizeOptions {
  const table = kind === 'balloon' ? BALLOON : STENT;
  return { diameters: table.diameters, lengths: table.lengths };
}

/** Whether the size of this catheter can be changed right now. */
export function canChooseSize(c: Catheter): boolean {
  return c.inGuide && !c.ruptured && !c.deployed;
}

export function isMovableTool(tool: ToolId): tool is MovableTool {
  return tool === 'guide' || tool === 'wire' || tool === 'balloon' || tool === 'stent';
}

/** The on-screen text for the inflation rule the learner needs most: predilation pressure and the rating. */
export function pressureAdvice(sim: Simulation): string {
  if (sim.tool === 'balloon') return `Pre-dilate at ${INFLATION.predilateMinAtm} atm or more, under the rated ${BALLOON.ratedBurstAtm} atm. Keep it short.`;
  if (sim.tool === 'stent') return `The stent opens from ${STENT.deployAtm} atm; nominal is ${STENT.nominalAtm} atm, rated ${STENT.ratedBurstAtm} atm.`;
  return '';
}
