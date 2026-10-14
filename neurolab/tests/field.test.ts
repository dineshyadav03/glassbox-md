import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/rules';
import {
  NO_TARGET,
  act,
  allowedRetraction,
  dopplerReading,
  flowing,
  initialField,
  nextSegment,
  setClip,
  tick,
  type Action,
  type FieldEvent,
  type FieldState,
  type Target,
} from '../src/procedure/field';
import { TOOLS, toolForKey, type ToolId } from '../src/tools/tools';

const ORDER = RULES.arachnoidOrder;
const arach = (id: string): Target => ({ kind: 'arachnoid', id });
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const DOME: Target = { kind: 'aneurysm', part: 'dome' };
const ICA: Target = { kind: 'vessel', id: 'ica' };

/** Apply actions in turn, returning the final state and every event. */
function run(state: FieldState, ...actions: Action[]): { state: FieldState; events: FieldEvent[] } {
  const events: FieldEvent[] = [];
  let current = state;
  for (const action of actions) {
    const result = act(current, action);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}
const use = (tool: ToolId, target: Target): Action => ({ type: 'click', tool, target });
const codes = (events: FieldEvent[]): string[] => events.map((e) => e.code);

/** A learner who cuts every membrane in order and holds the lobes apart. */
function opened(): FieldState {
  return run(initialField(), ...ORDER.map((id) => use('scissors', arach(id))), use('spatula', NO_TARGET)).state;
}
function neckFree(): FieldState {
  const steps = Math.ceil(RULES.neckFreedForClip / RULES.dissectorStep);
  return run(opened(), ...Array.from({ length: steps }, () => use('dissector', NECK))).state;
}

describe('the tool table', () => {
  it('has ten tools on keys 1 to 9 then 0, each once', () => {
    expect(TOOLS).toHaveLength(10);
    expect(TOOLS.map((t) => t.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']);
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(10);
    expect(toolForKey('0')?.id).toBe('tempClip');
    expect(toolForKey('a')).toBeUndefined();
  });

  it('holds only suction and bipolar down; the rest are clicks', () => {
    expect(TOOLS.filter((t) => t.hold).map((t) => t.id)).toEqual(['suction', 'bipolar']);
  });
});

describe('scissors and the arachnoid', () => {
  it('cut a membrane segment, in order, outer first', () => {
    const first = ORDER[0]!;
    const { state, events } = run(initialField(), use('scissors', arach(first)));
    expect(state.cut).toEqual([first]);
    expect(codes(events)).toEqual(['cut']);
    expect(nextSegment(state)).toBe(ORDER[1]);
  });

  it('refuse a deeper segment while a nearer one is intact', () => {
    const { state, events } = run(initialField(), use('scissors', arach(ORDER[2]!)));
    expect(state.cut).toEqual([]);
    expect(codes(events)).toEqual(['wrong-order']);
  });

  it('say so when a segment is already cut, and change nothing', () => {
    const once = run(initialField(), use('scissors', arach(ORDER[0]!))).state;
    const again = run(once, use('scissors', arach(ORDER[0]!)));
    expect(again.state).toEqual(once);
    expect(codes(again.events)).toEqual(['already-cut']);
  });

  it('report no next segment when all are cut', () => {
    expect(nextSegment(opened())).toBeNull();
  });

  it('injure what they should not touch: a vessel bleeds, a nerve is cut, the aneurysm ruptures', () => {
    const onVessel = run(initialField(), use('scissors', ICA));
    expect(codes(onVessel.events)).toEqual(['cut-injury']);
    expect(onVessel.state.oozes).toHaveLength(1);
    expect(onVessel.state.oozes[0]!.brisk).toBe(true);
    expect(onVessel.state.injuries[0]).toMatchObject({ target: 'ica', tool: 'scissors', kind: 'cut' });

    const onNerve = run(initialField(), use('scissors', { kind: 'nerve', id: 'optic' }));
    expect(onNerve.state.injuries[0]).toMatchObject({ target: 'optic', kind: 'cut' });

    const onSac = run(initialField(), use('scissors', DOME));
    expect(onSac.state.ruptured).toBe(true);
    expect(codes(onSac.events)).toEqual(['rupture']);
  });

  it('do nothing useful on empty space', () => {
    const { state, events } = run(initialField(), use('scissors', NO_TARGET));
    expect(state).toEqual(initialField());
    expect(codes(events)).toEqual(['noop']);
  });
});

describe('the spatula and the fissure', () => {
  it('will not hold the lobes apart while the membrane is intact', () => {
    const { state, events } = run(initialField(), use('spatula', NO_TARGET));
    expect(state.retraction).toBe(0);
    expect(codes(events)).toEqual(['bound']);
  });

  it('opens a third of the way for each fissure segment cut', () => {
    const one = run(initialField(), use('scissors', arach(ORDER[0]!)));
    expect(allowedRetraction(one.state)).toBeCloseTo(1 / 3, 9);
    const held = run(one.state, use('spatula', NO_TARGET));
    expect(held.state.retraction).toBeCloseTo(1 / 3, 9);
    expect(codes(held.events)).toEqual(['retracted']);
  });

  it('is fully open once the three fissure segments are cut, and the carotid membrane does not add to it', () => {
    const three = run(initialField(), ...ORDER.slice(0, 3).map((id) => use('scissors', arach(id))));
    expect(allowedRetraction(three.state)).toBe(1);
    expect(allowedRetraction(opened())).toBe(1);
  });

  it('releases when clicked again', () => {
    const { state, events } = run(opened(), use('spatula', NO_TARGET));
    expect(state.retraction).toBe(0);
    expect(codes(events)).toEqual(['released']);
  });

  it('counts the seconds the lobes are held apart, and only then', () => {
    expect(tick(initialField(), 5).retractionSeconds).toBe(0);
    const held = tick(tick(opened(), 4), 6);
    expect(held.retractionSeconds).toBe(10);
  });
});

describe('the dissector and the neck', () => {
  it('cannot reach the neck until the fissure is open and the carotid membrane is cut', () => {
    const closed = run(initialField(), use('dissector', NECK));
    expect(codes(closed.events)).toEqual(['neck-blocked']);
    expect(closed.state.neckFreed).toBe(0);

    const noCistern = run(initialField(), ...ORDER.slice(0, 3).map((id) => use('scissors', arach(id))), use('spatula', NO_TARGET), use('dissector', NECK));
    expect(codes(noCistern.events).at(-1)).toBe('neck-blocked');
  });

  it('frees the neck a step at a time, and the first stroke starts a small ooze to seal', () => {
    const first = run(opened(), use('dissector', NECK));
    expect(first.state.neckFreed).toBeCloseTo(RULES.dissectorStep, 9);
    expect(first.state.oozes.map((o) => o.id)).toEqual(['ooze-neck']);
    const second = run(first.state, use('dissector', NECK));
    expect(second.state.neckFreed).toBeCloseTo(2 * RULES.dissectorStep, 9);
    expect(second.state.oozes).toHaveLength(1);
  });

  it('never frees more than all of it', () => {
    let state = opened();
    for (let i = 0; i < 12; i++) state = run(state, use('dissector', NECK)).state;
    expect(state.neckFreed).toBe(1);
  });

  it('strains the dome when it works on the dome, and the third rough stroke ruptures it', () => {
    let state = opened();
    const warned = run(state, use('dissector', DOME));
    expect(warned.state.domeStress).toBeCloseTo(RULES.domeStressRoughStroke, 9);
    expect(codes(warned.events)).toEqual(['rough']);
    state = warned.state;
    let last: FieldEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const next = run(state, use('dissector', DOME));
      state = next.state;
      last = next.events;
    }
    expect(state.ruptured).toBe(true);
    expect(codes(last)).toContain('rupture');
  });

  it('ignore a click that is not on the aneurysm', () => {
    expect(codes(run(opened(), use('dissector', ICA)).events)).toEqual(['noop']);
  });
});

describe('bipolar', () => {
  const ooze = (state: FieldState): Target => ({ kind: 'ooze', id: state.oozes[0]!.id });
  const hold = (state: FieldState, target: Target, dt: number): ReturnType<typeof run> => run(state, { type: 'hold', tool: 'bipolar', target, dt });

  it('seals a bleeding point after the held time, not before', () => {
    const state = run(opened(), use('dissector', NECK)).state;
    const early = hold(state, ooze(state), RULES.coagulateSeconds / 2);
    expect(early.state.oozes).toHaveLength(1);
    expect(codes(early.events)).toEqual(['sealing']);
    const late = hold(early.state, ooze(state), RULES.coagulateSeconds / 2 + 0.01);
    expect(late.state.oozes).toHaveLength(0);
    expect(codes(late.events)).toEqual(['sealed']);
  });

  it('needs longer for the leak from a cut vessel', () => {
    const state = run(initialField(), use('scissors', ICA)).state;
    expect(hold(state, ooze(state), RULES.coagulateSeconds + 0.1).state.oozes).toHaveLength(1);
    expect(hold(state, ooze(state), RULES.briskCoagulateSeconds + 0.1).state.oozes).toHaveLength(0);
  });

  it('injures a vessel or nerve held too long, once', () => {
    const slow = hold(initialField(), ICA, RULES.thermalLimitSeconds - 0.1);
    expect(slow.state.injuries).toHaveLength(0);
    const burned = hold(slow.state, ICA, 0.2);
    expect(burned.state.injuries).toEqual([expect.objectContaining({ target: 'ica', kind: 'thermal' })]);
    expect(codes(burned.events)).toEqual(['burned']);
    expect(hold(burned.state, ICA, 1).state.injuries).toHaveLength(1);
    const nerve = hold(initialField(), { kind: 'nerve', id: 'optic' }, RULES.thermalLimitSeconds + 0.1);
    expect(nerve.state.injuries[0]).toMatchObject({ target: 'optic', kind: 'thermal' });
  });

  it('strains the dome much faster than suction does, and ruptures it in the end', () => {
    const s = hold(initialField(), DOME, 1);
    expect(s.state.domeStress).toBeCloseTo(RULES.domeStressBipolarPerSecond, 9);
    const r = hold(s.state, DOME, 1.1);
    expect(r.state.ruptured).toBe(true);
  });

  it('leaves the neck alone and ignores empty space', () => {
    expect(hold(initialField(), NECK, 1).state).toEqual(initialField());
    expect(hold(initialField(), NO_TARGET, 1).state).toEqual(initialField());
  });
});

describe('suction', () => {
  const suck = (state: FieldState, target: Target, dt: number) => run(state, { type: 'hold', tool: 'suction', target, dt });

  it('clears pooled blood at the stated rate and never below zero', () => {
    const wet = { ...initialField(), pooled: 10 };
    expect(suck(wet, NO_TARGET, 1).state.pooled).toBeCloseTo(10 - RULES.suctionRate, 9);
    expect(suck(wet, NO_TARGET, 100).state.pooled).toBe(0);
  });

  it('puts a little strain on the dome, but far less than bipolar', () => {
    const s = suck(initialField(), DOME, 1).state;
    expect(s.domeStress).toBeCloseTo(RULES.domeStressSuctionPerSecond, 9);
    expect(RULES.domeStressSuctionPerSecond).toBeLessThan(RULES.domeStressBipolarPerSecond);
  });

  it('does not strain the neck, and a zero or negative step does nothing', () => {
    expect(suck(initialField(), NECK, 1).state.domeStress).toBe(0);
    expect(suck({ ...initialField(), pooled: 3 }, NO_TARGET, 0).state.pooled).toBe(3);
  });

  it('is ignored as a click, and a click-only tool ignores a hold', () => {
    expect(run(initialField(), use('suction', NO_TARGET)).state).toEqual(initialField());
    expect(run(initialField(), { type: 'hold', tool: 'scissors', target: arach(ORDER[0]!), dt: 1 }).state).toEqual(initialField());
  });
});

describe('the temporary clip', () => {
  it('goes on the carotid only', () => {
    expect(codes(run(initialField(), use('tempClip', NO_TARGET)).events)).toEqual(['temp-refused']);
    expect(codes(run(initialField(), use('tempClip', { kind: 'vessel', id: 'm1' })).events)).toEqual(['temp-refused']);
    const on = run(initialField(), use('tempClip', ICA));
    expect(on.state.tempClip.on).toBe(true);
    expect(codes(on.events)).toEqual(['temp-on']);
  });

  it('runs a clock while on, keeps a total across clips, and stops when released', () => {
    let state = run(initialField(), use('tempClip', ICA)).state;
    state = tick(state, 40);
    expect(state.tempClip.seconds).toBe(40);
    const off = run(state, use('tempClip', ICA));
    expect(off.state.tempClip).toEqual({ on: false, seconds: 0, totalSeconds: 40 });
    expect(codes(off.events)).toEqual(['temp-off']);
    expect(tick(off.state, 100).tempClip.totalSeconds).toBe(40);
    const again = tick(run(off.state, use('tempClip', ICA)).state, 15);
    expect(again.tempClip.totalSeconds).toBe(55);
    expect(again.tempClip.seconds).toBe(15);
  });

  it('has warning thresholds in a sensible order', () => {
    expect(RULES.tempClipWarnSeconds).toBeLessThan(RULES.tempClipLongSeconds);
  });
});

describe('flow, ICG and Doppler', () => {
  it('flows everywhere, including the sac, in the open field', () => {
    const f = flowing(initialField());
    for (const id of ['ica', 'm1', 'm2-upper', 'm2-lower', 'a1', 'pcom', 'achoa', 'aneurysm']) expect(f.has(id as 'ica')).toBe(true);
  });

  it('stops everywhere while the temporary clip is on', () => {
    const state = run(initialField(), use('tempClip', ICA)).state;
    expect(flowing(state).size).toBe(0);
    expect(flowing(run(state, use('tempClip', ICA)).state).size).toBeGreaterThan(0);
  });

  it('stops filling the sac once a clip is across the neck, and keeps the parent vessels', () => {
    const clipped = run(neckFree(), use('clip', NECK)).state;
    const f = flowing(clipped);
    expect(f.has('aneurysm')).toBe(false);
    expect(f.has('ica')).toBe(true);
    expect(f.has('pcom')).toBe(true);
  });

  it('toggles the fluorescence view, and the endoscope view', () => {
    const icg = run(initialField(), use('icg', NO_TARGET));
    expect(icg.state.view).toBe('icg');
    expect(run(icg.state, use('icg', NO_TARGET)).state.view).toBe('white');
    const scope = run(initialField(), use('endoscope', NO_TARGET));
    expect(scope.state.endoscope).toBe(true);
    expect(run(scope.state, use('endoscope', NO_TARGET)).state.endoscope).toBe(false);
  });

  it('makes a tone only on a vessel or sac with flow, and silence on everything else', () => {
    const open = initialField();
    expect(dopplerReading(open, ICA).flow).toBe(true);
    expect(dopplerReading(open, DOME).flow).toBe(true);
    expect(dopplerReading(open, { kind: 'nerve', id: 'optic' }).flow).toBe(false);
    expect(dopplerReading(open, { kind: 'lobe', id: 'frontal' }).flow).toBe(false);
    expect(dopplerReading(open, NO_TARGET).flow).toBe(false);
    const occluded = run(open, use('tempClip', ICA)).state;
    expect(dopplerReading(occluded, { kind: 'vessel', id: 'm1' }).flow).toBe(false);
    expect(dopplerReading(occluded, DOME).flow).toBe(false);
  });

  it('reports the reading when the Doppler is clicked', () => {
    expect(codes(run(initialField(), use('doppler', ICA)).events)).toEqual(['doppler']);
    expect(run(initialField(), use('doppler', ICA)).events[0]!.tone).toBe('good');
    expect(run(initialField(), use('doppler', NO_TARGET)).events[0]!.tone).toBe('info');
  });
});

describe('the clip', () => {
  it('has a setup that stays inside its limits', () => {
    const s = setClip(initialField(), { angleDeg: 500, depth: 4, variant: 'curved' });
    expect(s.clipSetup).toEqual({ variant: 'curved', angleDeg: RULES.clipAngleLimitDeg, depth: 1 });
    const t = setClip(s, { angleDeg: -500, depth: -3 });
    expect(t.clipSetup).toEqual({ variant: 'curved', angleDeg: -RULES.clipAngleLimitDeg, depth: 0 });
    expect(act(initialField(), { type: 'setClip', angleDeg: 30 }).state.clipSetup.angleDeg).toBe(30);
  });

  it('is refused on the dome, and on a neck that is not free yet', () => {
    expect(codes(run(neckFree(), use('clip', DOME)).events)).toEqual(['clip-refused']);
    const notYet = run(opened(), use('dissector', NECK), use('clip', NECK));
    expect(codes(notYet.events).at(-1)).toBe('clip-refused');
    expect(notYet.state.clip).toBeNull();
  });

  it('goes on a free neck with the setup chosen at the time, and records when', () => {
    const state = tick(run(neckFree(), { type: 'setClip', variant: 'curved', angleDeg: 20, depth: 0.8 }).state, 3);
    const on = run(state, use('clip', NECK));
    expect(on.state.clip).toEqual({ variant: 'curved', angleDeg: 20, depth: 0.8, appliedAt: state.time });
    expect(codes(on.events)).toEqual(['clip-on']);
  });

  it('is applied once; removing it lets another be placed', () => {
    const on = run(neckFree(), use('clip', NECK)).state;
    expect(codes(run(on, use('clip', NECK)).events)).toEqual(['clip-refused']);
    const off = run(on, { type: 'removeClip' });
    expect(off.state.clip).toBeNull();
    expect(codes(off.events)).toEqual(['clip-off']);
    expect(run(off.state, use('clip', NECK)).state.clip).not.toBeNull();
    expect(run(initialField(), { type: 'removeClip' }).events).toEqual([]);
  });

  it('can be applied on a ruptured aneurysm, as an emergency', () => {
    const burst = { ...neckFree(), ruptured: true };
    expect(run(burst, use('clip', NECK)).state.clip).not.toBeNull();
  });
});

describe('a scripted learner', () => {
  it('opens the fissure, frees the neck, seals the ooze, clips, and ends with a clean record', () => {
    let state = neckFree();
    expect(state.oozes).toHaveLength(1);
    state = run(state, { type: 'hold', tool: 'bipolar', target: { kind: 'ooze', id: 'ooze-neck' }, dt: RULES.coagulateSeconds + 0.1 }).state;
    expect(state.oozes).toHaveLength(0);
    state = run(state, use('tempClip', ICA)).state;
    state = tick(state, 30);
    state = run(state, use('clip', NECK), use('tempClip', ICA)).state;
    expect(state.clip).not.toBeNull();
    expect(state.tempClip.totalSeconds).toBe(30);
    expect(state.injuries).toEqual([]);
    expect(state.ruptured).toBe(false);
    expect(flowing(state).has('aneurysm')).toBe(false);
  });

  it('never mutates the state it was given', () => {
    const before = opened();
    const snapshot = JSON.parse(JSON.stringify(before)) as FieldState;
    run(before, use('dissector', NECK), use('scissors', ICA), { type: 'hold', tool: 'bipolar', target: DOME, dt: 1 });
    expect(before).toEqual(snapshot);
  });
});
