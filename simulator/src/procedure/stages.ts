/**
 * The six stages of the case, their latching sub-tasks, and which tools are unlocked when.
 * Pure functions: the engine derives `ProcedureFacts` from the device and patient state each
 * frame, and this module decides what that means for progress. A sub-task latches the first
 * time its condition holds while its stage is current and stays done; a stage completes when
 * all its sub-tasks have latched. Later stages do not latch early.
 */

export type ToolId = 'guide' | 'wire' | 'balloon' | 'stent' | 'contrast' | 'fluoro' | 'measure';

/** Tools in the order of the 1 to 7 keys. */
export const TOOL_ORDER: readonly ToolId[] = ['guide', 'wire', 'balloon', 'stent', 'contrast', 'fluoro', 'measure'];

/** What is currently true of the case. Booleans marked "now" are live; the rest may be latched by the engine. */
export interface ProcedureFacts {
  // stage 1
  readonly guidePastElbow: boolean;
  readonly guideInAorta: boolean;
  /** The fluoro pedal was pressed while the guide was past the elbow. */
  readonly fluoroUsedPastElbow: boolean;
  readonly guideAtRoot: boolean;
  // stage 2
  /** At the root with the tip within the window of the left cusp. */
  readonly guideFacedLeftCusp: boolean;
  /** The guide is seated in the left main right now. */
  readonly guideEngagedNow: boolean;
  /** A selective injection was made with the guide engaged. */
  readonly diagnosticAngiogram: boolean;
  // stage 3
  readonly heparinGiven: boolean;
  readonly wireOut: boolean;
  readonly wireReachedLad: boolean;
  readonly wireCrossedLesion: boolean;
  readonly wireParkedDistally: boolean;
  /** The wire tip is beyond the lesion right now (needed to run a balloon or stent over it). */
  readonly wireBeyondLesionNow: boolean;
  // stage 4
  readonly balloonAcrossLesion: boolean;
  /** Inflated to at least 6 atm while across the lesion. */
  readonly balloonInflatedOverLesion: boolean;
  readonly balloonDeflatedAfter: boolean;
  // stage 5
  readonly qcaMeasured: boolean;
  readonly stentLoaded: boolean;
  readonly stentCoversLesion: boolean;
  readonly stentDeployedAndDeflated: boolean;
  // stage 6
  readonly angiogramAfterStent: boolean;
  /** Distinct C-arm projections used for selective injections after the stent. */
  readonly distinctProjectionsAfterStent: number;
  // live equipment state, for tool locks
  readonly balloonCatheterOut: boolean;
  readonly stentCatheterOut: boolean;
}

export const NO_FACTS: ProcedureFacts = {
  guidePastElbow: false, guideInAorta: false, fluoroUsedPastElbow: false, guideAtRoot: false,
  guideFacedLeftCusp: false, guideEngagedNow: false, diagnosticAngiogram: false,
  heparinGiven: false, wireOut: false, wireReachedLad: false, wireCrossedLesion: false,
  wireParkedDistally: false, wireBeyondLesionNow: false,
  balloonAcrossLesion: false, balloonInflatedOverLesion: false, balloonDeflatedAfter: false,
  qcaMeasured: false, stentLoaded: false, stentCoversLesion: false, stentDeployedAndDeflated: false,
  angiogramAfterStent: false, distinctProjectionsAfterStent: 0,
  balloonCatheterOut: false, stentCatheterOut: false,
};

export interface SubTask {
  readonly id: string;
  readonly label: string;
  /** A calm, specific nudge for when this is the next thing to do. */
  readonly hint: string;
  readonly done: (facts: ProcedureFacts) => boolean;
}

export interface StageDef {
  readonly title: string;
  readonly goal: string;
  /** The "Why this step?" teaching note. */
  readonly why: string;
  readonly subtasks: readonly SubTask[];
}

export const STAGES: readonly StageDef[] = [
  {
    title: 'Advance the guide to the aortic root',
    goal: 'Take the guide catheter from the wrist to the aortic root, checking its position on fluoroscopy.',
    why: 'Every later step runs through this catheter. Moving it under fluoroscopy, not blind, is how you know where its tip is.',
    subtasks: [
      { id: 's1.past-elbow', label: 'Pass the elbow', hint: 'Advance the guide with W; it travels up the right radial artery.', done: (f) => f.guidePastElbow },
      { id: 's1.into-aorta', label: 'Reach the aorta', hint: 'Keep advancing past the shoulder, through the brachiocephalic trunk, into the aorta.', done: (f) => f.guideInAorta },
      { id: 's1.fluoro', label: 'Look at it on fluoroscopy', hint: 'Hold the fluoro pedal (Space) to see where the catheter is. Never advance blind.', done: (f) => f.fluoroUsedPastElbow },
      { id: 's1.root', label: 'Reach the aortic root', hint: 'Advance until the guide stops at the aortic root.', done: (f) => f.guideAtRoot },
    ],
  },
  {
    title: 'Engage the left main',
    goal: 'Seat the guide in the left main coronary artery and take a diagnostic angiogram.',
    why: 'A seated guide gives a stable platform to work from. The pre-shaped tip has to face the left coronary cusp, so rotation matters as much as advancing.',
    subtasks: [
      { id: 's2.face-left', label: 'Face the left coronary cusp', hint: 'Rotate with A and D until the tip points at the left cusp, then stop.', done: (f) => f.guideFacedLeftCusp },
      { id: 's2.seated', label: 'Seat the guide in the left main', hint: 'Advance gently. A fast push bounces off the ostium instead of seating.', done: (f) => f.guideEngagedNow },
      { id: 's2.angiogram', label: 'Take a diagnostic angiogram', hint: 'With the guide seated, hold the fluoro pedal and inject contrast (C) to see the left coronary tree.', done: (f) => f.diagnosticAngiogram },
    ],
  },
  {
    title: 'Cross the LAD lesion',
    goal: 'Give heparin, then steer the guidewire into the LAD, across the 90% blockage without forcing it, and park it beyond.',
    why: 'Heparin first, because a wire in the artery can trigger clots. The wire then has to choose the LAD at each bifurcation by tip rotation, and cross the blockage slowly, since forcing it can tear the wall.',
    subtasks: [
      { id: 's3.heparin', label: 'Give heparin', hint: 'Give heparin (G) before the wire goes into the coronary artery.', done: (f) => f.heparinGiven },
      { id: 's3.wire-out', label: 'Advance the wire out of the guide', hint: 'Select the wire (2) and advance it out of the guide into the left main.', done: (f) => f.wireOut },
      { id: 's3.into-lad', label: 'Steer into the LAD, not the circumflex', hint: 'At the end of the left main, rotate the wire tip toward the LAD angle before it passes the bifurcation.', done: (f) => f.wireReachedLad },
      { id: 's3.cross', label: 'Cross the lesion', hint: 'Advance slowly through the blockage; spinning the wire as you go lets you move a little faster.', done: (f) => f.wireCrossedLesion },
      { id: 's3.park', label: 'Park the wire beyond the lesion', hint: 'Advance past the second diagonal and stop well short of the end of the vessel.', done: (f) => f.wireParkedDistally },
    ],
  },
  {
    title: 'Pre-dilate',
    goal: 'Run a balloon over the wire, inflate it across the lesion to at least 6 atm, and deflate.',
    why: 'A 90% blockage is too tight for a stent to cross and expand well. The balloon opens it first. Inflation also stops blood flow, so keep it short.',
    subtasks: [
      { id: 's4.across', label: 'Put the balloon across the lesion', hint: 'Select the balloon (3), choose a size while it is in the guide, advance over the wire until its markers span the lesion.', done: (f) => f.balloonAcrossLesion },
      { id: 's4.inflate', label: 'Inflate to at least 6 atm over the lesion', hint: 'Hold E to inflate and watch the pressure gauge; stay under the rated burst pressure.', done: (f) => f.balloonInflatedOverLesion },
      { id: 's4.deflate', label: 'Deflate', hint: 'Deflate with Q. The patient is not getting blood past the balloon while it is up.', done: (f) => f.balloonDeflatedAfter },
    ],
  },
  {
    title: 'Deploy the stent',
    goal: 'Measure the vessel, load a stent of suitable size, cover the whole lesion, deploy it and deflate.',
    why: 'The stent holds the opened artery open. It is sized to the vessel (measured, not guessed) and has to cover the whole lesion, with a small margin at each end.',
    subtasks: [
      { id: 's5.qca', label: 'Measure the vessel (QCA)', hint: 'Select the measure tool (7) to read the reference diameter and lesion length.', done: (f) => f.qcaMeasured },
      { id: 's5.loaded', label: 'Load a stent', hint: 'Withdraw the balloon, select the stent (4) and choose a diameter and length from the measurements.', done: (f) => f.stentLoaded },
      { id: 's5.cover', label: 'Cover the whole lesion', hint: 'Advance the stent until it extends past both ends of the lesion.', done: (f) => f.stentCoversLesion },
      { id: 's5.deploy', label: 'Deploy and deflate', hint: 'Inflate with E toward the stent\'s nominal pressure, then deflate with Q.', done: (f) => f.stentDeployedAndDeflated },
    ],
  },
  {
    title: 'Final angiogram',
    goal: 'Inject contrast after the stent, from two different projections.',
    why: 'The result is judged by looking: is the artery open, is flow brisk, is there a tear? A second angle avoids missing something hidden behind overlapping vessels.',
    subtasks: [
      { id: 's6.angiogram', label: 'Inject contrast after the stent', hint: 'Hold the fluoro pedal and inject contrast (C) with the guide seated.', done: (f) => f.angiogramAfterStent },
      { id: 's6.second-view', label: 'Repeat from a second projection', hint: 'Change the C-arm angle (V) and inject again.', done: (f) => f.distinctProjectionsAfterStent >= 2 },
    ],
  },
];

// --- progress ----------------------------------------------------------------------------------

export interface Progress {
  readonly latched: Readonly<Record<string, boolean>>;
  /** Seconds into the case when each stage completed, or null. */
  readonly completedAt: readonly (number | null)[];
}

export function initialProgress(): Progress {
  return { latched: {}, completedAt: STAGES.map(() => null) };
}

/** The 0-based stage the learner is on; STAGES.length once the case is finished. */
export function currentStageIndex(progress: Progress): number {
  const index = progress.completedAt.findIndex((t) => t === null);
  return index === -1 ? STAGES.length : index;
}

export function isProcedureComplete(progress: Progress): boolean {
  return currentStageIndex(progress) === STAGES.length;
}

/** Latch whatever has become true for the current stage, completing stages (and chaining into the next) as it goes. */
export function advanceProgress(progress: Progress, facts: ProcedureFacts, nowS: number): Progress {
  const latched: Record<string, boolean> = { ...progress.latched };
  const completedAt = [...progress.completedAt];
  let index = currentStageIndex(progress);
  while (index < STAGES.length) {
    const stage = STAGES[index]!;
    for (const task of stage.subtasks) {
      if (!latched[task.id] && task.done(facts)) latched[task.id] = true;
    }
    if (!stage.subtasks.every((task) => latched[task.id])) break;
    completedAt[index] = nowS;
    index += 1;
  }
  return { latched, completedAt };
}

/** Share of all sub-tasks done, 0 to 1, for the progress bar. */
export function overallProgress(progress: Progress): number {
  const all = STAGES.flatMap((stage) => stage.subtasks);
  return all.filter((task) => progress.latched[task.id]).length / all.length;
}

/** Share of the current stage's sub-tasks done, 0 to 1 (1 when the case is finished). */
export function stageProgress(progress: Progress): number {
  const stage = STAGES[currentStageIndex(progress)];
  if (!stage) return 1;
  return stage.subtasks.filter((task) => progress.latched[task.id]).length / stage.subtasks.length;
}

/** The nudge for the first undone sub-task of the current stage. */
export function nextHint(progress: Progress): string {
  const stage = STAGES[currentStageIndex(progress)];
  if (!stage) return 'All six steps are done. Review the debrief.';
  const task = stage.subtasks.find((t) => !progress.latched[t.id]);
  return task ? task.hint : '';
}

// --- tool unlocks --------------------------------------------------------------------------------------

export interface ToolAvailability {
  readonly available: boolean;
  /** Why not, in a sentence, when unavailable. */
  readonly reason: string | null;
}

const OK: ToolAvailability = { available: true, reason: null };
const locked = (reason: string): ToolAvailability => ({ available: false, reason });

export function toolAvailability(tool: ToolId, progress: Progress, facts: ProcedureFacts): ToolAvailability {
  switch (tool) {
    case 'guide':
    case 'fluoro':
      return OK;
    case 'contrast':
      return facts.guideInAorta ? OK : locked('Advance the guide into the aorta before injecting contrast.');
    case 'measure':
      return facts.diagnosticAngiogram ? OK : locked('Take a diagnostic angiogram first, so there is an image to measure.');
    case 'wire':
      if (facts.wireOut) return OK;
      if (!facts.guideEngagedNow) return locked('Seat the guide in the left main before using the wire.');
      if (!facts.diagnosticAngiogram) return locked('Take a diagnostic angiogram before wiring the artery.');
      if (!facts.heparinGiven) return locked('Give heparin (G) before wiring the artery.');
      return OK;
    case 'balloon':
      if (facts.balloonCatheterOut) return OK;
      if (facts.stentCatheterOut) return locked('Only one balloon catheter can be out at a time. Withdraw the stent catheter first.');
      if (!facts.wireBeyondLesionNow) return locked('Cross the lesion with the wire and park it beyond first.');
      return OK;
    case 'stent':
      if (facts.stentCatheterOut) return OK;
      if (progress.completedAt[3] === null) return locked('Pre-dilate the lesion with a balloon first.');
      if (facts.balloonCatheterOut) return locked('Withdraw the balloon catheter before loading a stent: only one can be out at a time.');
      if (!facts.wireBeyondLesionNow) return locked('The wire must still be across the lesion to deliver a stent.');
      return OK;
  }
}
