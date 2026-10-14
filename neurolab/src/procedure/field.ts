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
import { t } from '../i18n';
import { evaluateClip } from '../physics/clipEval';
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
  /** Findings after clipping: 'pcom-flow', 'sac-silent', 'icg-checked', and the bad ones 'sac-fills', 'pcom-silent', 'ica-narrowed'. */
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
  if (!state.clip) return new Set<VesselId | 'aneurysm'>(['ica', 'm1', 'm2-upper', 'm2-lower', 'a1', 'pcom', 'achoa', 'aneurysm']);
  const result = evaluateClip(state.clip);
  const all: (VesselId | 'aneurysm')[] = ['ica'];
  // A clip that narrows the carotid too far starves everything beyond it.
  if (result.icaNarrowingPct < RULES.clip.blockNarrowingPct) {
    all.push('m1', 'm2-upper', 'm2-lower', 'a1');
    if (result.pcomOpen) all.push('pcom');
    if (result.achoaOpen) all.push('achoa');
  }
  if (!result.closed) all.push('aneurysm');
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
    return flows.has(target.id) ? { flow: true, text: t('ev.flow.vessel') } : { flow: false, text: t('ev.silence.vessel') };
  }
  if (target.kind === 'aneurysm') {
    if (flows.has('aneurysm') && state.clip) return { flow: true, text: t('ev.flow.sacStill') };
    return flows.has('aneurysm') ? { flow: true, text: t('ev.flow.sac') } : { flow: false, text: t('ev.silence.sac') };
  }
  return { flow: false, text: t('ev.silence.notVessel') };
}

// --- time ---------------------------------------------------------------------------------------------------

/** How fast blood is being lost right now, millilitres per second. */
export function bleedRate(state: FieldState): number {
  let rate = 0;
  for (const o of state.oozes) rate += o.brisk ? RULES.bleedBriskMlPerSecond : RULES.bleedOozeMlPerSecond;
  if (state.ruptured) {
    const leak = state.clip ? (evaluateClip(state.clip).closed ? 0 : RULES.clip.leakFraction) : 1;
    rate += RULES.bleedRuptureMlPerSecond * leak;
  }
  return state.tempClip.on ? rate * RULES.tempClipBleedFactor : rate;
}

/** Blood fills the field so the surgeon cannot see to work. */
export function isObstructed(state: FieldState): boolean {
  return state.pooled >= RULES.obstructedAtPool;
}

const obstructedText = (): string => t('ev.obstructed');

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
  return done(next, event('rupture', 'bad', t('ev.rupture', { why })));
}

function addStress(state: FieldState, tool: ToolId, amount: number, why: string): Result {
  const stress = clamp(state.domeStress + amount, 0, 1);
  const next = { ...state, domeStress: stress };
  if (stress >= RULES.ruptureStress) return rupture(next, tool, why);
  return done(next);
}

function scissors(state: FieldState, target: Target): Result {
  if (target.kind === 'arachnoid') {
    if (state.cut.includes(target.id)) return done(state, event('already-cut', 'info', t('ev.alreadyCut')));
    const next = nextSegment(state);
    if (next !== target.id) {
      return done(state, event('wrong-order', 'warn', t('ev.wrongOrder')));
    }
    return done({ ...state, cut: [...state.cut, target.id] }, event('cut', 'good', t('ev.cut')));
  }
  if (target.kind === 'vessel') {
    const ooze: Ooze = { id: `cut-${target.id}-${state.injuries.length}`, on: target.id, remaining: RULES.briskCoagulateSeconds, brisk: true };
    return done(
      { ...state, oozes: [...state.oozes, ooze], injuries: [...state.injuries, { target: target.id, tool: 'scissors', kind: 'cut', time: state.time }] },
      event('cut-injury', 'bad', t('ev.cutArtery')),
    );
  }
  if (target.kind === 'aneurysm') return rupture(state, 'scissors', t('why.scissors'));
  if (target.kind === 'nerve') {
    return done(
      { ...state, injuries: [...state.injuries, { target: target.id, tool: 'scissors', kind: 'cut', time: state.time }] },
      event('cut-injury', 'bad', t('ev.cutNerve')),
    );
  }
  return done(state, event('noop', 'info', t('ev.scissorsNoop')));
}

function spatula(state: FieldState): Result {
  const allowed = allowedRetraction(state);
  if (state.retraction > 0) return done({ ...state, retraction: 0 }, event('released', 'info', t('ev.released')));
  if (allowed <= 0) return done(state, event('bound', 'warn', t('ev.bound')));
  return done({ ...state, retraction: allowed, peakRetraction: Math.max(state.peakRetraction, allowed) }, event('retracted', 'good', allowed >= 1 ? t('ev.retractedFull') : t('ev.retractedPartial')));
}

function dissector(state: FieldState, target: Target): Result {
  if (target.kind === 'aneurysm' && (target.part === 'dome' || target.part === 'bleb')) {
    const touched = addStress(state, 'dissector', RULES.domeStressRoughStroke, t('why.dissector'));
    if (touched.state.ruptured && !state.ruptured) return touched;
    return { state: touched.state, events: [event('rough', 'warn', t('ev.rough'))] };
  }
  if (target.kind !== 'aneurysm') return done(state, event('noop', 'info', t('ev.dissectorNoop')));
  if (isObstructed(state)) return done(state, event('obstructed', 'warn', obstructedText()));
  if (!state.cut.includes('arach-ica') || state.retraction < RULES.retractionNeededForNeck) {
    return done(state, event('neck-blocked', 'warn', t('ev.neckBlocked')));
  }
  const freed = clamp(state.neckFreed + RULES.dissectorStep, 0, 1);
  const first = state.neckFreed === 0 && !state.oozes.some((o) => o.id === 'ooze-neck');
  const oozes = first ? [...state.oozes, { id: 'ooze-neck', on: 'neck' as const, remaining: RULES.coagulateSeconds, brisk: false }] : state.oozes;
  const text = freed >= RULES.neckFreedForClip ? t('ev.neckFree') : t('ev.neckMore');
  return done({ ...state, neckFreed: freed, oozes }, event('neck-freed', 'good', first ? `${text} ${t('ev.neckOoze')}` : text));
}

function tempClip(state: FieldState, target: Target): Result {
  if (target.kind !== 'vessel' || target.id !== 'ica') {
    return done(state, event('temp-refused', 'warn', t('ev.tempRefused')));
  }
  if (state.tempClip.on) {
    return done(
      { ...state, tempClip: { on: false, seconds: 0, totalSeconds: state.tempClip.totalSeconds } },
      event('temp-off', 'good', t('ev.tempOff', { s: Math.round(state.tempClip.seconds) })),
    );
  }
  return done({ ...state, tempClip: { ...state.tempClip, on: true, seconds: 0 } }, event('temp-on', 'info', t('ev.tempOn')));
}

function applyClip(state: FieldState, target: Target): Result {
  if (target.kind !== 'aneurysm' || target.part !== 'neck') {
    return done(state, event('clip-refused', 'warn', t('ev.clipDome')));
  }
  if (isObstructed(state)) return done(state, event('obstructed', 'warn', obstructedText()));
  if (state.clip) return done(state, event('clip-refused', 'warn', t('ev.clipOn')));
  if (state.neckFreed < RULES.neckFreedForClip) {
    return done(state, event('clip-refused', 'warn', t('ev.clipFree')));
  }
  return done({ ...state, checks: [], clip: { ...state.clipSetup, appliedAt: state.time } }, event('clip-on', 'good', t('ev.clipApplied')));
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
      let checks = checked ? addOnce(state.checks, 'icg-checked') : state.checks;
      if (checked && state.clip && evaluateClip(state.clip).icaNarrowingPct >= RULES.clip.noticeNarrowingPct) checks = addOnce(checks, 'ica-narrowed');
      return done(
        { ...state, view, checks },
        event('view', 'info', view === 'icg' ? t('ev.viewOn') : t('ev.viewOff')),
      );
    }
    case 'endoscope': {
      const on = !state.endoscope;
      return done({ ...state, endoscope: on }, event('endoscope', 'info', on ? t('ev.scopeOn') : t('ev.scopeOff')));
    }
    case 'doppler': {
      const reading = dopplerReading(state, target);
      // After clipping: flow in the posterior communicating artery and silence in the sac are the checks that matter.
      let checks = state.checks;
      if (state.clip && !state.tempClip.on) {
        if (target.kind === 'vessel' && target.id === 'pcom') checks = addOnce(checks, reading.flow ? 'pcom-flow' : 'pcom-silent');
        if (target.kind === 'aneurysm') checks = addOnce(checks, reading.flow ? 'sac-fills' : 'sac-silent');
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
    return addStress(cleared, 'suction', RULES.domeStressSuctionPerSecond * dt, t('why.suction'));
  }
  return done(cleared);
}

function bipolar(state: FieldState, target: Target, dt: number): Result {
  if (target.kind === 'ooze') {
    const found = state.oozes.find((o) => o.id === target.id);
    if (!found) return done(state);
    const remaining = found.remaining - dt;
    if (remaining <= 0) {
      return done({ ...state, oozes: state.oozes.filter((o) => o.id !== found.id) }, event('sealed', 'good', t('ev.sealed')));
    }
    return done({ ...state, oozes: state.oozes.map((o) => (o.id === found.id ? { ...o, remaining } : o)) }, event('sealing', 'info', t('ev.sealing')));
  }
  if (target.kind === 'aneurysm') {
    if (target.part === 'neck') return done(state);
    return addStress(state, 'bipolar', RULES.domeStressBipolarPerSecond * dt, t('why.bipolar'));
  }
  if (target.kind === 'vessel' || target.kind === 'nerve') {
    const before = state.thermal[target.id] ?? 0;
    const after = before + dt;
    const next: FieldState = { ...state, thermal: { ...state.thermal, [target.id]: after } };
    if (before < RULES.thermalLimitSeconds && after >= RULES.thermalLimitSeconds) {
      return done(
        { ...next, injuries: [...next.injuries, { target: target.id, tool: 'bipolar', kind: 'thermal', time: state.time }] },
        event('burned', 'bad', t('ev.burned', { what: t(target.kind === 'vessel' ? 'kind.vessel' : 'kind.nerve') })),
      );
    }
    return done(next);
  }
  return done(state);
}

function hold(state: FieldState, tool: ToolId, target: Target, dt: number): Result {
  if (dt <= 0 || !TOOL_BY_ID[tool].hold) return done(state);
  if (tool === 'doppler') return click(state, 'doppler', target);
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
  if (id === null) return done(state, event('noop', 'info', t('ev.identifyNoop')));
  return done({ ...state, identified: addOnce(state.identified, id) }, event('identified', 'info', t('ev.identified', { name: describeTarget(target) })));
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
      return state.clip ? done({ ...state, checks: [], clip: null }, event('clip-off', 'info', t('ev.clipRemoved'))) : done(state);
  }
}
