/**
 * The state of the operative field and the rules of the ten tools, as pure functions: `act` applies one use of a
 * tool to a state and returns the next state with what happened (events); `tick` moves time on. No Three.js, no DOM,
 * so a scripted learner can play it in a test. Bleeding, vitals and the clip's evaluation come in later milestones;
 * here a tool only does what its rule says and leaves a record of it.
 */
import { RULES } from '../config/rules';
import type { NerveId, VesselId } from '../anatomy/vessels';
import type { ToolId } from '../tools/tools';
import { TOOL_BY_ID } from '../tools/tools';
import { describeTarget } from '../anatomy/targets';
import { baselineVitals, stepVitals, type Vitals } from '../physics/vitals';

export type Target =
  | { readonly kind: 'none' }
  | { readonly kind: 'lobe'; readonly id: 'frontal' | 'temporal' }
  | { readonly kind: 'arachnoid'; readonly id: string }
  | { readonly kind: 'vessel'; readonly id: VesselId }
  | { readonly kind: 'nerve'; readonly id: NerveId }
  | { readonly kind: 'aneurysm'; readonly part: 'neck' | 'dome' | 'bleb' }
  | { readonly kind: 'ooze'; readonly id: string };

export const NO_TARGET: Target = { kind: 'none' };

/** A small leak that bipolar can seal. */
export interface Ooze {
  readonly id: string;
  /** Where it is: a vessel, or the aneurysm neck. */
  readonly on: VesselId | 'neck';
  /** Seconds of bipolar still needed to seal it. */
  readonly remaining: number;
  /** A leak from a cut vessel: needs longer. */
  readonly brisk: boolean;
}

export interface Injury {
  readonly target: string;
  readonly tool: ToolId;
  readonly kind: 'cut' | 'thermal' | 'rupture';
  readonly time: number;
}

export type ClipVariant = 'straight' | 'curved';

export interface ClipSetup {
  readonly variant: ClipVariant;
  /** Rotation about the neck axis, degrees. */
  readonly angleDeg: number;
  /** How deep the blades reach across the neck, 0 to 1. */
  readonly depth: number;
}

export interface AppliedClip extends ClipSetup {
  readonly appliedAt: number;
}

export interface FieldState {
  readonly time: number;
  /** Membrane segments cut so far, in the order they were cut. */
  readonly cut: readonly string[];
  /** How far the fissure is held open, 0 to 1. */
  readonly retraction: number;
  /** The most it has been held open so far, 0 to 1 (so releasing the spatula does not undo the step). */
  readonly peakRetraction: number;
  /** Structures the learner has pointed at and identified: vessel ids, nerve ids, and 'aneurysm'. */
  readonly identified: readonly string[];
  /** Checks made after clipping: 'pcom-flow', 'sac-silent', 'icg-checked'. */
  readonly checks: readonly string[];
  /** Seconds the lobes have been held apart. */
  readonly retractionSeconds: number;
  /** How free the aneurysm neck is of the carotid, 0 to 1. */
  readonly neckFreed: number;
  /** Strain on the dome, 0 to 1. */
  readonly domeStress: number;
  readonly ruptured: boolean;
  readonly oozes: readonly Ooze[];
  /** Blood lying in the field, in pool units. */
  readonly pooled: number;
  /** Estimated blood lost so far, millilitres. */
  readonly ebl: number;
  readonly vitals: Vitals;
  /** Seconds of bipolar heat on each vessel or nerve. */
  readonly thermal: Readonly<Record<string, number>>;
  readonly injuries: readonly Injury[];
  readonly tempClip: { readonly on: boolean; readonly seconds: number; readonly totalSeconds: number };
  readonly clipSetup: ClipSetup;
  readonly clip: AppliedClip | null;
  readonly view: 'white' | 'icg';
  readonly endoscope: boolean;
}

export type EventCode =
  | 'cut'
  | 'already-cut'
  | 'wrong-order'
  | 'retracted'
  | 'released'
  | 'bound'
  | 'neck-freed'
  | 'neck-blocked'
  | 'rough'
  | 'sealed'
  | 'sealing'
  | 'burned'
  | 'cut-injury'
  | 'rupture'
  | 'clip-on'
  | 'clip-refused'
  | 'clip-off'
  | 'view'
  | 'identified'
  | 'endoscope'
  | 'doppler'
  | 'temp-on'
  | 'temp-off'
  | 'temp-refused'
  | 'obstructed'
  | 'noop';

export interface FieldEvent {
  readonly code: EventCode;
  readonly tone: 'info' | 'good' | 'warn' | 'bad';
  readonly text: string;
}

export interface Result {
  readonly state: FieldState;
  readonly events: readonly FieldEvent[];
}

export type Action =
  | { readonly type: 'click'; readonly tool: ToolId; readonly target: Target }
  | { readonly type: 'hold'; readonly tool: ToolId; readonly target: Target; readonly dt: number }
  | { readonly type: 'identify'; readonly target: Target }
  | { readonly type: 'setClip'; readonly variant?: ClipVariant; readonly angleDeg?: number; readonly depth?: number }
  | { readonly type: 'removeClip' };

export function initialField(): FieldState {
  return {
    time: 0,
    cut: [],
    retraction: 0,
    peakRetraction: 0,
    identified: [],
    checks: [],
    retractionSeconds: 0,
    neckFreed: 0,
    domeStress: 0,
    ruptured: false,
    oozes: [],
    pooled: 0,
    ebl: 0,
    vitals: baselineVitals(),
    thermal: {},
    injuries: [],
    tempClip: { on: false, seconds: 0, totalSeconds: 0 },
    clipSetup: { variant: 'straight', angleDeg: 0, depth: 0.5 },
    clip: null,
    view: 'white',
    endoscope: false,
  };
}

const event = (code: EventCode, tone: FieldEvent['tone'], text: string): FieldEvent => ({ code, tone, text });
const done = (state: FieldState, ...events: FieldEvent[]): Result => ({ state, events });
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const addOnce = (list: readonly string[], id: string): readonly string[] => (list.includes(id) ? list : [...list, id]);

// --- reading the state -------------------------------------------------------------------------------------

/** How open the fissure may be held, 0 to 1: one third for each of the fissure's membrane segments that has been cut. */
export function allowedRetraction(state: FieldState): number {
  const open = RULES.arachnoidOrder.slice(0, RULES.fissureSegmentCount).filter((id) => state.cut.includes(id)).length;
  return open / RULES.fissureSegmentCount;
}

/** The next membrane segment that may be cut, or null when all are cut. */
export function nextSegment(state: FieldState): string | null {
  return RULES.arachnoidOrder.find((id) => !state.cut.includes(id)) ?? null;
}

/** What has blood flowing in it right now. The carotid feeds everything beyond it; a temporary clip stops that. */
export function flowing(state: FieldState): ReadonlySet<VesselId | 'aneurysm'> {
  if (state.tempClip.on) return new Set();
  const all: (VesselId | 'aneurysm')[] = ['ica', 'm1', 'm2-upper', 'm2-lower', 'a1', 'pcom', 'achoa'];
  // The sac fills unless a clip is across its neck (how well is judged in a later milestone).
  if (!state.clip) all.push('aneurysm');
  return new Set(all);
}

export interface DopplerReading {
  readonly flow: boolean;
  readonly text: string;
}

/** What the Doppler probe reports on a target: a pulsing tone where blood flows, silence everywhere else. */
export function dopplerReading(state: FieldState, target: Target): DopplerReading {
  const flows = flowing(state);
  if (target.kind === 'vessel') {
    return flows.has(target.id) ? { flow: true, text: 'Flow: a steady pulsing tone.' } : { flow: false, text: 'Silence: no flow in this vessel.' };
  }
  if (target.kind === 'aneurysm') {
    return flows.has('aneurysm') ? { flow: true, text: 'Flow: the sac is filling.' } : { flow: false, text: 'Silence: the sac is not filling.' };
  }
  return { flow: false, text: 'Silence: this is not a vessel.' };
}

// --- time ---------------------------------------------------------------------------------------------------

/** How fast blood is being lost right now, millilitres per second. */
export function bleedRate(state: FieldState): number {
  let rate = 0;
  for (const o of state.oozes) rate += o.brisk ? RULES.bleedBriskMlPerSecond : RULES.bleedOozeMlPerSecond;
  if (state.ruptured && !state.clip) rate += RULES.bleedRuptureMlPerSecond;
  return state.tempClip.on ? rate * RULES.tempClipBleedFactor : rate;
}

/** Blood fills the field so the surgeon cannot see to work. */
export function isObstructed(state: FieldState): boolean {
  return state.pooled >= RULES.obstructedAtPool;
}

const OBSTRUCTED = 'You cannot see: blood fills the field. Clear it with suction first.';

/** Move time on: the clocks run, blood is lost and pools, and the vital signs follow. */
export function tick(state: FieldState, dt: number): FieldState {
  const step = Math.max(0, dt);
  const lost = bleedRate(state) * step;
  const ebl = state.ebl + lost;
  return {
    ...state,
    time: state.time + step,
    ebl,
    pooled: Math.min(RULES.poolMax, state.pooled + lost * RULES.poolPerMl),
    vitals: stepVitals(state.vitals, ebl, state.tempClip.on, state.tempClip.seconds, step),
    retractionSeconds: state.retraction > 0 ? state.retractionSeconds + step : state.retractionSeconds,
    tempClip: state.tempClip.on
      ? { on: true, seconds: state.tempClip.seconds + step, totalSeconds: state.tempClip.totalSeconds + step }
      : state.tempClip,
  };
}

// --- the tools ---------------------------------------------------------------------------------------------

function rupture(state: FieldState, tool: ToolId, why: string): Result {
  if (state.ruptured) return done(state);
  const next: FieldState = {
    ...state,
    ruptured: true,
    domeStress: 1,
    injuries: [...state.injuries, { target: 'aneurysm', tool, kind: 'rupture', time: state.time }],
  };
  return done(next, event('rupture', 'bad', `The aneurysm has ruptured (${why}).`));
}

function addStress(state: FieldState, tool: ToolId, amount: number, why: string): Result {
  const stress = clamp(state.domeStress + amount, 0, 1);
  const next = { ...state, domeStress: stress };
  if (stress >= RULES.ruptureStress) return rupture(next, tool, why);
  return done(next);
}

function scissors(state: FieldState, target: Target): Result {
  if (target.kind === 'arachnoid') {
    if (state.cut.includes(target.id)) return done(state, event('already-cut', 'info', 'That membrane is already cut.'));
    const next = nextSegment(state);
    if (next !== target.id) {
      return done(state, event('wrong-order', 'warn', 'Cut the outer membrane first: the deeper ones are reached through it.'));
    }
    return done({ ...state, cut: [...state.cut, target.id] }, event('cut', 'good', 'Membrane cut.'));
  }
  if (target.kind === 'vessel') {
    const ooze: Ooze = { id: `cut-${target.id}-${state.injuries.length}`, on: target.id, remaining: RULES.briskCoagulateSeconds, brisk: true };
    return done(
      { ...state, oozes: [...state.oozes, ooze], injuries: [...state.injuries, { target: target.id, tool: 'scissors', kind: 'cut', time: state.time }] },
      event('cut-injury', 'bad', 'The scissors have cut an artery. It is bleeding.'),
    );
  }
  if (target.kind === 'aneurysm') return rupture(state, 'scissors', 'cut by the scissors');
  if (target.kind === 'nerve') {
    return done(
      { ...state, injuries: [...state.injuries, { target: target.id, tool: 'scissors', kind: 'cut', time: state.time }] },
      event('cut-injury', 'bad', 'The scissors have cut a nerve.'),
    );
  }
  return done(state, event('noop', 'info', 'Scissors cut the arachnoid membrane. Click a membrane.'));
}

function spatula(state: FieldState): Result {
  const allowed = allowedRetraction(state);
  if (state.retraction > 0) return done({ ...state, retraction: 0 }, event('released', 'info', 'The lobes are released.'));
  if (allowed <= 0) return done(state, event('bound', 'warn', 'The fissure is bound by arachnoid. Cut the outer membrane first.'));
  return done({ ...state, retraction: allowed, peakRetraction: Math.max(state.peakRetraction, allowed) }, event('retracted', 'good', allowed >= 1 ? 'The fissure is open and held.' : 'Held as far as the cut membrane allows. Cut more to open it further.'));
}

function dissector(state: FieldState, target: Target): Result {
  if (target.kind === 'aneurysm' && (target.part === 'dome' || target.part === 'bleb')) {
    const touched = addStress(state, 'dissector', RULES.domeStressRoughStroke, 'rough handling of the dome');
    if (touched.state.ruptured && !state.ruptured) return touched;
    return { state: touched.state, events: [event('rough', 'warn', 'Do not work on the dome. Free the neck, from the carotid side.')] };
  }
  if (target.kind !== 'aneurysm') return done(state, event('noop', 'info', 'The dissector frees the aneurysm neck. Click the neck.'));
  if (isObstructed(state)) return done(state, event('obstructed', 'warn', OBSTRUCTED));
  if (!state.cut.includes('arach-ica') || state.retraction < RULES.retractionNeededForNeck) {
    return done(state, event('neck-blocked', 'warn', 'You cannot reach the neck yet: open the fissure and cut the membrane over the carotid.'));
  }
  const freed = clamp(state.neckFreed + RULES.dissectorStep, 0, 1);
  const first = state.neckFreed === 0 && !state.oozes.some((o) => o.id === 'ooze-neck');
  const oozes = first ? [...state.oozes, { id: 'ooze-neck', on: 'neck' as const, remaining: RULES.coagulateSeconds, brisk: false }] : state.oozes;
  const text = freed >= RULES.neckFreedForClip ? 'The neck is free enough to clip.' : 'Neck freed a little more.';
  return done({ ...state, neckFreed: freed, oozes }, event('neck-freed', 'good', first ? `${text} A small point is oozing: seal it with bipolar.` : text));
}

function tempClip(state: FieldState, target: Target): Result {
  if (target.kind !== 'vessel' || target.id !== 'ica') {
    return done(state, event('temp-refused', 'warn', 'The temporary clip goes on the carotid, before the aneurysm.'));
  }
  if (state.tempClip.on) {
    return done(
      { ...state, tempClip: { on: false, seconds: 0, totalSeconds: state.tempClip.totalSeconds } },
      event('temp-off', 'good', `Temporary clip released after ${Math.round(state.tempClip.seconds)} s.`),
    );
  }
  return done({ ...state, tempClip: { ...state.tempClip, on: true, seconds: 0 } }, event('temp-on', 'info', 'Temporary clip on the carotid. The clock is running.'));
}

function applyClip(state: FieldState, target: Target): Result {
  if (target.kind !== 'aneurysm' || target.part !== 'neck') {
    return done(state, event('clip-refused', 'warn', 'The clip goes across the neck, not the dome. Click the neck.'));
  }
  if (isObstructed(state)) return done(state, event('obstructed', 'warn', OBSTRUCTED));
  if (state.clip) return done(state, event('clip-refused', 'warn', 'A clip is already on. Remove it (Backspace) to place it again.'));
  if (state.neckFreed < RULES.neckFreedForClip) {
    return done(state, event('clip-refused', 'warn', 'Free the neck first: the blades need room on both sides.'));
  }
  return done({ ...state, clip: { ...state.clipSetup, appliedAt: state.time } }, event('clip-on', 'good', 'Clip applied. Check it before you finish.'));
}

function click(state: FieldState, tool: ToolId, target: Target): Result {
  switch (tool) {
    case 'scissors':
      return scissors(state, target);
    case 'spatula':
      return spatula(state);
    case 'dissector':
      return dissector(state, target);
    case 'clip':
      return applyClip(state, target);
    case 'tempClip':
      return tempClip(state, target);
    case 'icg': {
      const view = state.view === 'icg' ? 'white' : 'icg';
      const checked = view === 'icg' && state.clip !== null && !state.tempClip.on;
      return done(
        { ...state, view, checks: checked ? addOnce(state.checks, 'icg-checked') : state.checks },
        event('view', 'info', view === 'icg' ? 'Fluorescence view on.' : 'White-light view.'),
      );
    }
    case 'endoscope': {
      const on = !state.endoscope;
      return done({ ...state, endoscope: on }, event('endoscope', 'info', on ? 'Endoscope view open.' : 'Endoscope view closed.'));
    }
    case 'doppler': {
      const reading = dopplerReading(state, target);
      // After clipping: flow in the posterior communicating artery and silence in the sac are the checks that matter.
      let checks = state.checks;
      if (state.clip && !state.tempClip.on) {
        if (target.kind === 'vessel' && target.id === 'pcom' && reading.flow) checks = addOnce(checks, 'pcom-flow');
        if (target.kind === 'aneurysm' && !reading.flow) checks = addOnce(checks, 'sac-silent');
      }
      return done({ ...state, checks }, event('doppler', reading.flow ? 'good' : 'info', reading.text));
    }
    default:
      return done(state);
  }
}

function suction(state: FieldState, target: Target, dt: number): Result {
  const pooled = Math.max(0, state.pooled - RULES.suctionRate * dt);
  const cleared = { ...state, pooled };
  if (target.kind === 'aneurysm' && (target.part === 'dome' || target.part === 'bleb')) {
    return addStress(cleared, 'suction', RULES.domeStressSuctionPerSecond * dt, 'suction on the dome');
  }
  return done(cleared);
}

function bipolar(state: FieldState, target: Target, dt: number): Result {
  if (target.kind === 'ooze') {
    const found = state.oozes.find((o) => o.id === target.id);
    if (!found) return done(state);
    const remaining = found.remaining - dt;
    if (remaining <= 0) {
      return done({ ...state, oozes: state.oozes.filter((o) => o.id !== found.id) }, event('sealed', 'good', 'Sealed.'));
    }
    return done({ ...state, oozes: state.oozes.map((o) => (o.id === found.id ? { ...o, remaining } : o)) }, event('sealing', 'info', 'Sealing...'));
  }
  if (target.kind === 'aneurysm') {
    if (target.part === 'neck') return done(state);
    return addStress(state, 'bipolar', RULES.domeStressBipolarPerSecond * dt, 'bipolar on the dome');
  }
  if (target.kind === 'vessel' || target.kind === 'nerve') {
    const before = state.thermal[target.id] ?? 0;
    const after = before + dt;
    const next: FieldState = { ...state, thermal: { ...state.thermal, [target.id]: after } };
    if (before < RULES.thermalLimitSeconds && after >= RULES.thermalLimitSeconds) {
      return done(
        { ...next, injuries: [...next.injuries, { target: target.id, tool: 'bipolar', kind: 'thermal', time: state.time }] },
        event('burned', 'bad', `Too much heat: that ${target.kind} is injured.`),
      );
    }
    return done(next);
  }
  return done(state);
}

function hold(state: FieldState, tool: ToolId, target: Target, dt: number): Result {
  if (dt <= 0 || !TOOL_BY_ID[tool].hold) return done(state);
  if (tool === 'suction') return suction(state, target, dt);
  if (tool === 'bipolar') return bipolar(state, target, dt);
  return done(state);
}

/** The id a target is identified by, or null if it is not something to identify (membrane, lobes, leaks, empty space). */
export function identifiableId(target: Target): string | null {
  if (target.kind === 'vessel' || target.kind === 'nerve') return target.id;
  if (target.kind === 'aneurysm') return 'aneurysm';
  return null;
}

function identify(state: FieldState, target: Target): Result {
  const id = identifiableId(target);
  if (id === null) return done(state, event('noop', 'info', 'Point at an artery, a nerve or the aneurysm, then identify it.'));
  return done({ ...state, identified: addOnce(state.identified, id) }, event('identified', 'info', `That is: ${describeTarget(target)}.`));
}

export function setClip(state: FieldState, patch: { variant?: ClipVariant; angleDeg?: number; depth?: number }): FieldState {
  const limit = RULES.clipAngleLimitDeg;
  return {
    ...state,
    clipSetup: {
      variant: patch.variant ?? state.clipSetup.variant,
      angleDeg: clamp(patch.angleDeg ?? state.clipSetup.angleDeg, -limit, limit),
      depth: clamp(patch.depth ?? state.clipSetup.depth, 0, 1),
    },
  };
}

/** Apply one use of a tool (or an adjustment to the clip) to the field. */
export function act(state: FieldState, action: Action): Result {
  switch (action.type) {
    case 'click':
      return click(state, action.tool, action.target);
    case 'hold':
      return hold(state, action.tool, action.target, action.dt);
    case 'identify':
      return identify(state, action.target);
    case 'setClip':
      return done(setClip(state, action));
    case 'removeClip':
      return state.clip ? done({ ...state, clip: null }, event('clip-off', 'info', 'Clip removed.')) : done(state);
  }
}
