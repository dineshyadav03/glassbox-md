/**
 * The procedure engine: one place where the guide, wire, balloon and stent catheters, the patient, the
 * contrast and fluoroscopy bookkeeping and the six-stage progress are stepped together over time.
 * Every rule lives in the modules it calls (physics, tools, procedure); this file only composes them.
 *
 * Pure: `tick` and `act` return a new state and never touch the DOM, Three.js or the clock, and the one
 * random draw (the wire's dissection roll) is passed in, so a whole case can be replayed in a test.
 * Units: mm, atm, seconds, degrees.
 */
import {
  CARM,
  CARM_PRESETS,
  CATHETER,
  ELBOW_S,
  GUIDE,
  INFLATION,
  LESION,
  WIRE,
} from '../config/anatomy';
import {
  edgeDissectionS,
  isOversized,
  makeDissection,
  refreshSealing,
  type Dissection,
} from '../physics/dissection';
import {
  cineDurationSeconds,
  contrastVolumeMl,
  distalFlowFactor,
  simulateFlow,
  timiForVessel,
  type FlowResult,
  type FlowScene,
} from '../physics/flow';
import { createGuide, describeGuideEvent, facesLeftCusp, guideCheckpoints, stepGuide, type GuideEvent, type GuideState } from '../physics/guide';
import {
  lesionReferenceDiameter,
  referenceDiameterAt,
  worstResidualStenosis,
  type Treatment,
} from '../physics/lesion';
import {
  INITIAL_PHYSIOLOGY,
  giveHeparin,
  stepPhysiology,
  type PhysiologyState,
} from '../physics/physiology';
import {
  createWire,
  describeWireEvent,
  stepWire,
  wireBeyondLesion,
  wireParkedDistally,
  wirePathS,
  type WireEvent,
  type WireState,
} from '../physics/wire';
import { carmLabel, viewSeparationDeg, type CArmAngles } from '../xray/projection';
import { buildDebrief, type Debrief, type ProcedureSummary } from '../procedure/evaluation';
import {
  STAGES,
  advanceProgress,
  currentStageIndex,
  initialProgress,
  isProcedureComplete,
  nextHint,
  toolAvailability,
  type ProcedureFacts,
  type Progress,
  type ToolAvailability,
  type ToolId,
} from '../procedure/stages';
import {
  acrossLesion,
  chooseSize,
  createCatheter,
  isInflated,
  lesionCoverage,
  liveBalloonOf,
  loadFresh,
  longestInflationS,
  makeSpec,
  moveCatheter,
  placeInPatient,
  postDilateStents,
  stepInflation,
  treatmentsFor,
  withdrawToGuide,
  type Catheter,
  type CatheterKind,
  type InflationEvent,
} from '../tools/devices';

// --- types ------------------------------------------------------------------------------------

/** The four tools that are moved with the advance and rotate keys. */
export type MovableTool = 'guide' | 'wire' | 'balloon' | 'stent';

/** What the learner is holding down right now. */
export interface Controls {
  /** -1 (retract) to 1 (advance). */
  readonly advance: number;
  /** -1 to 1; the sign is the direction the tip turns. */
  readonly rotate: number;
  /** Fine control: slower movement and slower inflation. */
  readonly fine: boolean;
  readonly inflate: boolean;
  readonly deflate: boolean;
  /** The fluoroscopy pedal. */
  readonly fluoro: boolean;
}

export const NO_CONTROLS: Controls = { advance: 0, rotate: 0, fine: false, inflate: false, deflate: false, fluoro: false };

export type Action =
  | { readonly type: 'select-tool'; readonly tool: MovableTool }
  | { readonly type: 'heparin' }
  | { readonly type: 'inject' }
  | { readonly type: 'measure' }
  | { readonly type: 'choose-size'; readonly kind: CatheterKind; readonly diameter: number; readonly length: number }
  | { readonly type: 'cycle-carm'; readonly direction: 1 | -1 }
  | { readonly type: 'select-carm'; readonly index: number }
  /** Nudge the C-arm by this many degrees (LAO positive, cranial positive). */
  | { readonly type: 'adjust-carm'; readonly laoDeg: number; readonly cranialDeg: number }
  | { readonly type: 'end-case' };

export type MessageLevel = 'info' | 'good' | 'warn' | 'bad';

export interface Message {
  readonly t: number;
  readonly text: string;
  readonly level: MessageLevel;
}

/** One contrast injection and the cine run it produced. */
export interface Injection {
  readonly start: number;
  readonly duration: number;
  /** The guide was seated, so only the left system fills; otherwise it is an aortic root flush. */
  readonly selective: boolean;
  /** Fluoroscopy was on, so the run was recorded. */
  readonly recorded: boolean;
  /** Arrival times and flow at each ring; null for an aortic flush. */
  readonly result: FlowResult | null;
  readonly projectionId: string;
}

export interface Latches {
  readonly fluoroPastElbow: boolean;
  readonly diagnostic: boolean;
  readonly qca: boolean;
  readonly wireEverOut: boolean;
  readonly balloonInflatedOver: boolean;
  readonly angioAfterStent: boolean;
}

export interface QcaReading {
  readonly referenceDiameterMm: number;
  readonly lesionLengthMm: number;
  readonly stenosis: number;
}

export interface Simulation {
  readonly time: number;
  readonly tool: MovableTool;
  readonly guide: GuideState;
  readonly wire: WireState;
  readonly balloon: Catheter;
  readonly stent: Catheter;
  /** Treatments left by catheters that have been withdrawn and replaced (a deployed stent stays in the artery). */
  readonly archived: readonly Treatment[];
  readonly patient: PhysiologyState;
  readonly dissections: readonly Dissection[];
  readonly progress: Progress;
  readonly latch: Latches;
  readonly heparin: 'none' | 'before-wire' | 'late';
  readonly fluoroOn: boolean;
  readonly fluoroSeconds: number;
  readonly contrastMl: number;
  readonly injection: Injection | null;
  /** Index of the last preset chosen (the C-arm can then be nudged away from it). */
  readonly carm: number;
  /** Where the C-arm is now. */
  readonly carmAngles: CArmAngles;
  /** Distinct projections used for recorded selective injections after the stent. */
  readonly finalProjections: readonly CArmAngles[];
  readonly qca: QcaReading | null;
  readonly balloonRuptures: number;
  readonly longestInflation: number;
  readonly messages: readonly Message[];
  /** The case is over, finished or ended early. */
  readonly ended: boolean;
  readonly debrief: Debrief | null;
}

type Draft = { -readonly [K in keyof Simulation]: Simulation[K] };

const MAX_MESSAGES = 60;
const DEFAULT_BALLOON = { diameter: 2.5, length: 15 } as const;
const DEFAULT_STENT = { diameter: 3.0, length: 18 } as const;

function spec(kind: CatheterKind, diameter: number, length: number) {
  const s = makeSpec(kind, diameter, length);
  if (!s) throw new Error(`no ${kind} of ${diameter} x ${length} is stocked`);
  return s;
}

export function createSimulation(): Simulation {
  const first = nextHint(initialProgress());
  return {
    time: 0,
    tool: 'guide',
    guide: createGuide(),
    wire: createWire(),
    balloon: createCatheter(spec('balloon', DEFAULT_BALLOON.diameter, DEFAULT_BALLOON.length)),
    stent: createCatheter(spec('stent', DEFAULT_STENT.diameter, DEFAULT_STENT.length)),
    archived: [],
    patient: INITIAL_PHYSIOLOGY,
    dissections: [],
    progress: initialProgress(),
    latch: { fluoroPastElbow: false, diagnostic: false, qca: false, wireEverOut: false, balloonInflatedOver: false, angioAfterStent: false },
    heparin: 'none',
    fluoroOn: false,
    fluoroSeconds: 0,
    contrastMl: 0,
    injection: null,
    carm: 0,
    carmAngles: presetAngles(0),
    finalProjections: [],
    qca: null,
    balloonRuptures: 0,
    longestInflation: 0,
    messages: [{ t: 0, text: `Case start. ${first}`, level: 'info' }],
    ended: false,
    debrief: null,
  };
}

// --- derived views of the state ----------------------------------------------------------------

/** Every treated segment in the artery, with any stent enlarged by a larger balloon inflated inside it. */
export function treatmentsOf(sim: Simulation): Treatment[] {
  const parts = [...sim.archived, ...treatmentsFor(sim.balloon), ...treatmentsFor(sim.stent)];
  const stents = parts.filter((t) => t.kind === 'stent');
  const others = parts.filter((t) => t.kind !== 'stent');
  const live = [liveBalloonOf(sim.balloon), liveBalloonOf(sim.stent)].filter((t): t is Treatment => t !== null);
  let grown = stents;
  for (const balloon of live) grown = postDilateStents(grown, balloon);
  return [...others, ...grown];
}

export function flowSceneOf(sim: Simulation): FlowScene {
  return { treatments: treatmentsOf(sim), dissections: sim.dissections };
}

function deployedStents(sim: Simulation): Treatment[] {
  return treatmentsOf(sim).filter((t) => t.kind === 'stent');
}

function presetAngles(index: number): CArmAngles {
  const preset = CARM_PRESETS[index]!;
  return { laoDeg: preset.laoDeg, cranialDeg: preset.cranialDeg };
}

/** Where the C-arm is, with its readable name. */
export function currentCArm(sim: Simulation): CArmAngles & { readonly label: string } {
  return { ...sim.carmAngles, label: carmLabel(sim.carmAngles) };
}

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

export function factsOf(sim: Simulation): ProcedureFacts {
  const checkpoints = guideCheckpoints(sim.guide.s);
  const atRoot = checkpoints.atRoot;
  const stents = deployedStents(sim);
  const balloonOut = !sim.balloon.inGuide;
  const stentOut = !sim.stent.inGuide;
  const balloonAcross = balloonOut && sim.balloon.centreS !== null && acrossLesion(sim.balloon.centreS, sim.balloon.spec.length);
  const stentAtLesionCovers = stents.some((t) => lesionCoverage(t.centreS, t.length).coversLesion) ||
    (stentOut && sim.stent.centreS !== null && lesionCoverage(sim.stent.centreS, sim.stent.spec.length).coversLesion);
  const wireInLadTree = sim.wire.vessel === 'LAD' || sim.wire.vessel === 'D1' || sim.wire.vessel === 'D2';

  return {
    guidePastElbow: checkpoints.pastElbow,
    guideInAorta: checkpoints.inAorta,
    fluoroUsedPastElbow: sim.latch.fluoroPastElbow,
    guideAtRoot: atRoot,
    guideFacedLeftCusp: atRoot && facesLeftCusp(sim.guide.rotationDeg),
    guideEngagedNow: sim.guide.engaged,
    diagnosticAngiogram: sim.latch.diagnostic,
    heparinGiven: sim.patient.heparinGiven,
    wireOut: sim.wire.outOfGuide,
    wireReachedLad: wireInLadTree,
    wireCrossedLesion: wireBeyondLesion(sim.wire),
    wireParkedDistally: wireParkedDistally(sim.wire),
    wireBeyondLesionNow: wireBeyondLesion(sim.wire),
    balloonAcrossLesion: balloonAcross,
    balloonInflatedOverLesion: balloonAcross && sim.balloon.pressure >= INFLATION.predilateMinAtm,
    balloonDeflatedAfter: sim.latch.balloonInflatedOver && sim.balloon.pressure < INFLATION.inflatedAtm,
    qcaMeasured: sim.latch.qca,
    stentLoaded: stentOut || stents.length > 0,
    stentCoversLesion: stentAtLesionCovers,
    stentDeployedAndDeflated: stents.length > 0 && !isInflated(sim.stent),
    angiogramAfterStent: sim.latch.angioAfterStent,
    distinctProjectionsAfterStent: sim.finalProjections.length,
    balloonCatheterOut: balloonOut,
    stentCatheterOut: stentOut,
  };
}

/** Whether a tool can be used now, and if not, why. */
export function availability(sim: Simulation, tool: ToolId): ToolAvailability {
  return toolAvailability(tool, sim.progress, factsOf(sim));
}

export function stageIndexOf(sim: Simulation): number {
  return currentStageIndex(sim.progress);
}

export function hintOf(sim: Simulation): string {
  return nextHint(sim.progress);
}

// --- messages --------------------------------------------------------------------------------------

/** Say something to the learner. The same sentence is not repeated within three seconds. */
function say(draft: Draft, text: string, level: MessageLevel = 'info'): void {
  const last = draft.messages[draft.messages.length - 1];
  if (last && last.text === text && draft.time - last.t < 3) return;
  const next = [...draft.messages, { t: draft.time, text, level }];
  draft.messages = next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

function guideLevel(event: GuideEvent): MessageLevel {
  return event.type === 'engaged' ? 'good' : 'warn';
}

function wireLevel(event: WireEvent): MessageLevel {
  switch (event.type) {
    case 'crossed':
      return 'good';
    case 'dissection':
      return 'bad';
    case 'entered':
    case 'back-in-guide':
      return 'info';
    default:
      return 'warn';
  }
}

function describeInflation(event: InflationEvent, kind: CatheterKind): { text: string; level: MessageLevel } | null {
  switch (event.type) {
    case 'inflate-in-guide':
      return { text: 'Advance the catheter out of the guide before inflating it.', level: 'warn' };
    case 'over-rated':
      return { text: `Pressure is above the rated burst pressure (${event.pressureAtm.toFixed(1)} atm). Back off before it ruptures.`, level: 'warn' };
    case 'rupture':
      return { text: `The ${kind} ruptured at ${event.pressureAtm.toFixed(1)} atm. Withdraw it and load a fresh one.`, level: 'bad' };
    case 'deployed':
      return { text: 'The stent is deployed. Keep inflating toward its nominal pressure, then deflate.', level: 'good' };
    case 'spent':
      return { text: `This ${kind} has ruptured. Withdraw it and load a fresh one.`, level: 'warn' };
  }
}

// --- one step of time -----------------------------------------------------------------------------------

function catheterOf(draft: Draft, tool: 'balloon' | 'stent'): Catheter {
  return tool === 'balloon' ? draft.balloon : draft.stent;
}

function setCatheter(draft: Draft, tool: 'balloon' | 'stent', catheter: Catheter): void {
  if (tool === 'balloon') draft.balloon = catheter;
  else draft.stent = catheter;
}

/** Leave a withdrawn catheter's lasting effect on the artery behind, and put a fresh one of the same size in the guide. */
function archiveAndReload(draft: Draft, tool: 'balloon' | 'stent'): void {
  const old = catheterOf(draft, tool);
  draft.archived = [...draft.archived, ...treatmentsFor(old)];
  draft.longestInflation = Math.max(draft.longestInflation, longestInflationS(old));
  setCatheter(draft, tool, loadFresh(old));
}

function moveSelectedCatheter(draft: Draft, tool: 'balloon' | 'stent', advance: number, fine: boolean, dt: number): void {
  let catheter = catheterOf(draft, tool);
  const speed = fine ? CATHETER.fineAdvanceSpeed : CATHETER.advanceSpeed;
  const delta = advance * speed * dt;
  const half = catheter.spec.length / 2;

  if (delta < 0 && catheter.deployed && !isInflated(catheter)) {
    archiveAndReload(draft, tool);
    say(draft, 'The stent stays in the artery; its delivery catheter is withdrawn into the guide.', 'good');
    return;
  }
  if (delta < 0 && catheter.ruptured) {
    archiveAndReload(draft, tool);
    say(draft, `The ruptured ${tool} is withdrawn and a fresh one is loaded.`, 'info');
    return;
  }
  if (delta > 0 && catheter.deployed) {
    say(draft, 'The stent is deployed. Withdraw its delivery catheter, or load a fresh stent.', 'warn');
    return;
  }

  if (catheter.inGuide) {
    if (delta <= 0) return;
    const wire = draft.wire;
    const inLadTree = wire.outOfGuide && (wire.vessel === 'LAD' || wire.vessel === 'D1' || wire.vessel === 'D2');
    if (!inLadTree) {
      say(draft, 'The wire has to be in the LAD before a catheter can be passed over it.', 'warn');
      return;
    }
    catheter = placeInPatient(catheter, 'LAD', half);
  }

  const outcome = moveCatheter(catheter, delta, wirePathS(draft.wire) ?? undefined);
  catheter = outcome.catheter;
  if (outcome.blocked) say(draft, outcome.blocked, 'warn');

  if (delta < 0 && catheter.centreS !== null && catheter.centreS <= half + 1e-6) {
    const back = withdrawToGuide(catheter);
    if (back.ok) {
      catheter = back.value;
      say(draft, `The ${tool} catheter is back in the guide.`, 'info');
    } else {
      say(draft, back.reason, 'warn');
    }
  }
  setCatheter(draft, tool, catheter);
}

/** New records in a catheter's inflation log become dissections (over-sizing, rupture) and counters. */
function absorbNewRecords(draft: Draft, before: Catheter, after: Catheter): void {
  for (let i = before.log.length; i < after.log.length; i++) {
    const record = after.log[i]!;
    draft.longestInflation = Math.max(draft.longestInflation, record.durationS);
    if (record.vessel === null || record.centreS === null) continue;
    if (record.ruptured) {
      draft.balloonRuptures += 1;
      draft.dissections = [...draft.dissections, makeDissection(record.vessel, record.centreS, 'rupture')];
      say(draft, 'The balloon injured the vessel when it burst.', 'bad');
      continue;
    }
    if (after.spec.kind === 'balloon' && isOversized(record.achievedDiameter, referenceDiameterAt(record.vessel, record.centreS))) {
      const s = record.centreS + after.spec.length / 2;
      draft.dissections = [...draft.dissections, makeDissection(record.vessel, s, 'balloon')];
      say(draft, 'That balloon was too large for the vessel and has torn the wall at its distal end.', 'bad');
    }
  }
}

function addStentEdgeDissection(draft: Draft, stent: Catheter): void {
  if (!stent.deployed || !stent.deployedAt || stent.deployedDiameter === null) return;
  const reference = referenceDiameterAt(stent.deployedAt.vessel, stent.deployedAt.centreS);
  if (!isOversized(stent.deployedDiameter, reference)) return;
  const s = edgeDissectionS(stent.deployedAt.centreS, stent.spec.length);
  if (draft.dissections.some((d) => d.cause === 'stent' && d.s === s)) return;
  draft.dissections = [...draft.dissections, makeDissection(stent.deployedAt.vessel, s, 'stent')];
  say(draft, 'The stent is too large for the vessel and has torn the wall just beyond its end.', 'bad');
}

/** Advance the case by `dt` seconds. Pass the wire's one random draw as `rng` (default Math.random). */
export function tick(sim: Simulation, controls: Controls, dt: number, rng: () => number = Math.random): Simulation {
  if (sim.ended) return sim;
  const draft: Draft = { ...sim };
  draft.time = sim.time + dt;

  // 1. Move the selected tool.
  const tool = sim.tool;
  const advance = Math.max(-1, Math.min(1, controls.advance));
  const rotate = Math.max(-1, Math.min(1, controls.rotate));
  if (tool === 'guide') {
    const speed = controls.fine ? GUIDE.fineAdvanceSpeed : GUIDE.advanceSpeed;
    const result = stepGuide(draft.guide, { advanceSpeed: advance * speed, rotateRate: rotate * GUIDE.rotateRate }, { wireOut: draft.wire.outOfGuide }, dt);
    draft.guide = result.state;
    for (const event of result.events) say(draft, describeGuideEvent(event), guideLevel(event));
  } else if (tool === 'wire') {
    const speed = controls.fine ? WIRE.fineAdvanceSpeed : WIRE.advanceSpeed;
    const onWire = !draft.balloon.inGuide || !draft.stent.inGuide;
    const result = stepWire(
      draft.wire,
      { advanceSpeed: advance * speed, rotateRate: rotate * WIRE.rotateRate },
      { guideEngaged: draft.guide.engaged, balloonOnWire: onWire },
      dt,
      rng,
    );
    draft.wire = result.state;
    for (const event of result.events) {
      say(draft, describeWireEvent(event), wireLevel(event));
      if (event.type === 'dissection') draft.dissections = [...draft.dissections, makeDissection('LAD', event.s, 'wire')];
    }
  } else if (advance !== 0) {
    moveSelectedCatheter(draft, tool, advance, controls.fine, dt);
  }

  // 2. Inflation: input goes to the selected catheter; both keep their pressure and timers running.
  for (const kind of ['balloon', 'stent'] as const) {
    const before = catheterOf(draft, kind);
    const selected = tool === kind;
    const input = { inflate: selected && controls.inflate, deflate: selected && controls.deflate, fine: controls.fine };
    const result = stepInflation(before, input, dt);
    for (const event of result.events) {
      const note = describeInflation(event, kind);
      if (note) say(draft, note.text, note.level);
    }
    setCatheter(draft, kind, result.catheter);
    absorbNewRecords(draft, before, result.catheter);
  }
  addStentEdgeDissection(draft, draft.stent);
  draft.longestInflation = Math.max(draft.longestInflation, longestInflationS(draft.balloon), longestInflationS(draft.stent));

  // 3. Fluoroscopy.
  draft.fluoroOn = controls.fluoro;
  if (controls.fluoro) {
    draft.fluoroSeconds = sim.fluoroSeconds + dt;
    if (draft.guide.s >= ELBOW_S + 10 && !draft.latch.fluoroPastElbow) draft.latch = { ...draft.latch, fluoroPastElbow: true };
  }
  if (draft.wire.outOfGuide && !draft.latch.wireEverOut) draft.latch = { ...draft.latch, wireEverOut: true };

  // 4. The cine run ends.
  if (draft.injection && draft.time >= draft.injection.start + draft.injection.duration) draft.injection = null;

  // 5. The artery and the patient.
  const treatments = treatmentsOf(draft);
  draft.dissections = refreshSealing(draft.dissections, treatments);
  const scene: FlowScene = { treatments, dissections: draft.dissections };
  const ladFlow = distalFlowFactor(scene, 'LAD');
  const before = draft.patient;
  draft.patient = stepPhysiology(draft.patient, ladFlow, dt);
  const vitalsNow = draft.patient.occludedSeconds;
  if (vitalsNow > 60 && before.occludedSeconds <= 60) say(draft, 'Patient is unstable. Deflate now.', 'bad');
  else if (vitalsNow > 40 && before.occludedSeconds <= 40) say(draft, 'The ECG shows ectopic beats and the blood pressure is falling: the artery has been blocked too long.', 'warn');

  // 6. Latches that depend on the facts, then the stage progress.
  let facts = factsOf(draft);
  if (facts.balloonInflatedOverLesion && !draft.latch.balloonInflatedOver && deployedStents(draft).length === 0) {
    draft.latch = { ...draft.latch, balloonInflatedOver: true };
    facts = factsOf(draft);
  }
  const stageBefore = currentStageIndex(draft.progress);
  draft.progress = advanceProgress(draft.progress, facts, draft.time);
  const stageAfter = currentStageIndex(draft.progress);
  for (let i = stageBefore; i < stageAfter; i++) say(draft, `Step ${i + 1} complete: ${STAGES[i]!.title}.`, 'good');
  if (stageAfter !== stageBefore && !isProcedureComplete(draft.progress)) say(draft, nextHint(draft.progress), 'info');

  if (isProcedureComplete(draft.progress)) {
    draft.ended = true;
    draft.debrief = buildDebrief(summarize(draft as Simulation));
    say(draft, 'All six steps are done. Review the debrief.', 'good');
  }
  return draft;
}

// --- discrete actions ---------------------------------------------------------------------------------------

export function act(sim: Simulation, action: Action): Simulation {
  if (sim.ended) return sim;
  const draft: Draft = { ...sim };

  switch (action.type) {
    case 'select-tool': {
      const result = availability(sim, action.tool);
      if (!result.available) {
        say(draft, result.reason ?? 'That tool is not available yet.', 'warn');
        return draft;
      }
      draft.tool = action.tool;
      return draft;
    }

    case 'heparin': {
      if (sim.patient.heparinGiven) {
        say(draft, 'Heparin has already been given.', 'info');
        return draft;
      }
      draft.patient = giveHeparin(sim.patient);
      draft.heparin = sim.latch.wireEverOut ? 'late' : 'before-wire';
      say(draft, sim.latch.wireEverOut ? 'Heparin given, though the wire was already in the artery.' : 'Heparin given. The clotting time (ACT) will climb over the next minute.', sim.latch.wireEverOut ? 'warn' : 'good');
      return draft;
    }

    case 'inject': {
      if (sim.injection) {
        say(draft, 'A contrast run is still in progress.', 'info');
        return draft;
      }
      const result = availability(sim, 'contrast');
      if (!result.available) {
        say(draft, result.reason ?? 'Contrast is not available yet.', 'warn');
        return draft;
      }
      const selective = sim.guide.engaged;
      const recorded = sim.fluoroOn;
      const projection = currentCArm(sim);
      const flow = selective ? simulateFlow(flowSceneOf(sim)) : null;
      draft.contrastMl = sim.contrastMl + contrastVolumeMl(selective);
      draft.injection = {
        start: sim.time,
        duration: flow ? cineDurationSeconds(flow) : 2,
        selective,
        recorded,
        result: flow,
        projectionId: projection.label,
      };
      if (!recorded) {
        say(draft, 'Contrast was injected without fluoroscopy, so nothing was recorded. Hold the pedal (Space) while you inject.', 'warn');
        return draft;
      }
      if (!selective) {
        say(draft, 'An aortic root flush: dye fills the root but not the coronary arteries. Seat the guide for a selective injection.', 'info');
        return draft;
      }
      const timi = timiForVessel(flowSceneOf(sim), 'LAD');
      const afterStent = deployedStents(sim).length > 0;
      draft.latch = { ...sim.latch, diagnostic: true, angioAfterStent: sim.latch.angioAfterStent || afterStent };
      if (afterStent && sim.finalProjections.every((seen) => viewSeparationDeg(seen, sim.carmAngles) >= CARM.minSeparationDeg)) {
        draft.finalProjections = [...sim.finalProjections, sim.carmAngles];
      }
      say(draft, `Angiogram in ${projection.label}: LAD flow is TIMI ${timi}.`, timi === 3 ? 'good' : 'warn');
      return draft;
    }

    case 'measure': {
      const result = availability(sim, 'measure');
      if (!result.available) {
        say(draft, result.reason ?? 'Measuring is not available yet.', 'warn');
        return draft;
      }
      const reading: QcaReading = { referenceDiameterMm: lesionReferenceDiameter(), lesionLengthMm: LESION.length, stenosis: LESION.diameterStenosis };
      draft.qca = reading;
      draft.latch = { ...sim.latch, qca: true };
      say(
        draft,
        `Measured: reference diameter ${reading.referenceDiameterMm.toFixed(2)} mm, lesion length ${reading.lesionLengthMm} mm, stenosis ${Math.round(reading.stenosis * 100)}%.`,
        'info',
      );
      return draft;
    }

    case 'choose-size': {
      const catheter = action.kind === 'balloon' ? sim.balloon : sim.stent;
      const result = chooseSize(catheter, action.diameter, action.length);
      if (!result.ok) {
        say(draft, result.reason, 'warn');
        return draft;
      }
      if (action.kind === 'balloon') draft.balloon = result.value;
      else draft.stent = result.value;
      say(draft, `${action.kind === 'balloon' ? 'Balloon' : 'Stent'} set to ${action.diameter} x ${action.length} mm.`, 'info');
      return draft;
    }

    case 'cycle-carm': {
      const n = CARM_PRESETS.length;
      draft.carm = (((sim.carm + action.direction) % n) + n) % n;
      draft.carmAngles = presetAngles(draft.carm);
      return draft;
    }

    case 'select-carm': {
      const n = CARM_PRESETS.length;
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= n) return sim;
      draft.carm = action.index;
      draft.carmAngles = presetAngles(action.index);
      return draft;
    }

    case 'adjust-carm': {
      draft.carmAngles = {
        laoDeg: clamp(sim.carmAngles.laoDeg + action.laoDeg, CARM.laoRangeDeg),
        cranialDeg: clamp(sim.carmAngles.cranialDeg + action.cranialDeg, CARM.cranialRangeDeg),
      };
      return draft;
    }

    case 'end-case': {
      draft.ended = true;
      draft.debrief = buildDebrief(summarize(sim));
      say(draft, 'The case was ended before all six steps were finished.', 'warn');
      return draft;
    }
  }
}

// --- the debrief summary ----------------------------------------------------------------------------------

/** Everything the debrief needs, read off the state. */
export function summarize(sim: Simulation): ProcedureSummary {
  const treatments = treatmentsOf(sim);
  const stents = treatments.filter((t) => t.kind === 'stent');
  const first = stents[0] ?? null;
  const coverage = first ? lesionCoverage(first.centreS, first.length) : null;
  const scene: FlowScene = { treatments, dissections: sim.dissections };
  const touched = treatments.length > 0 || stents.length > 0;

  const anyUnsealed = sim.dissections.some((d) => !d.sealed);
  const dissection: ProcedureSummary['dissection'] = sim.dissections.length === 0 ? 'none' : anyUnsealed ? 'unsealed' : 'sealed';

  return {
    completed: isProcedureComplete(sim.progress),
    residualStenosis: touched ? worstResidualStenosis(treatments) : null,
    finalTimi: touched ? timiForVessel(scene, 'LAD') : null,
    stentDiameterRatio: first ? first.diameter / lesionReferenceDiameter() : null,
    proximalMarginMm: coverage ? coverage.proximalMarginMm : null,
    distalMarginMm: coverage ? coverage.distalMarginMm : null,
    stentsDeployed: stents.length,
    heparin: sim.heparin,
    predilated: sim.latch.balloonInflatedOver,
    qcaUsed: sim.latch.qca,
    dissection,
    wireForcingSeconds: sim.wire.forcingSeconds,
    balloonRuptures: sim.balloonRuptures,
    longestInflationS: Math.max(sim.longestInflation, longestInflationS(sim.balloon), longestInflationS(sim.stent)),
    contrastMl: sim.contrastMl,
    fluoroSeconds: sim.fluoroSeconds,
    finalViews: sim.finalProjections.length,
  };
}
