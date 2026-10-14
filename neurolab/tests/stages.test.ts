import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/rules';
import { act, initialField, tick, type Action, type FieldEvent, type FieldState, type Target } from '../src/procedure/field';
import { adviceNow, notesFor, type MentorNote } from '../src/procedure/mentor';
import { STAGES, allStagesDone, currentStage, nextTask, stageViews } from '../src/procedure/stages';
import type { ToolId } from '../src/tools/tools';

const NONE: Target = { kind: 'none' };
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const ICA: Target = { kind: 'vessel', id: 'ica' };
const vessel = (id: 'ica' | 'm1' | 'pcom' | 'achoa'): Target => ({ kind: 'vessel', id });
const arach = (id: string): Target => ({ kind: 'arachnoid', id });
const use = (tool: ToolId, target: Target): Action => ({ type: 'click', tool, target });
const identify = (target: Target): Action => ({ type: 'identify', target });

interface Played {
  state: FieldState;
  events: FieldEvent[];
  notes: MentorNote[];
}

/** Play actions one by one, collecting the events and the mentor's notes. */
function play(start: FieldState, ...actions: (Action | { wait: number })[]): Played {
  let state = start;
  const events: FieldEvent[] = [];
  const notes: MentorNote[] = [];
  for (const a of actions) {
    const prev = state;
    if ('wait' in a) {
      state = tick(state, a.wait);
      notes.push(...notesFor(prev, state, []));
      continue;
    }
    const result = act(state, a);
    state = result.state;
    events.push(...result.events);
    notes.push(...notesFor(prev, state, result.events));
  }
  return { state, events, notes };
}

const STEP1: Action[] = [...RULES.arachnoidOrder.slice(0, 3).map((id) => use('scissors', arach(id))), use('spatula', NONE)];
const STEP2: Action[] = [identify(vessel('m1'))];
const STEP3: Action[] = [identify(ICA), identify({ kind: 'nerve', id: 'optic' })];
const STEP4: Action[] = [
  identify(vessel('pcom')),
  identify(vessel('achoa')),
  use('scissors', arach(RULES.arachnoidOrder[3]!)),
  use('dissector', NECK),
  use('dissector', NECK),
  use('dissector', NECK),
];
type Step = Action | { wait: number };
const STEP5: Step[] = [use('tempClip', ICA), { type: 'setClip', variant: 'straight', angleDeg: 10, depth: 0.7 }, use('clip', NECK), { wait: 20 }, use('tempClip', ICA)];
const STEP6: Action[] = [use('doppler', { kind: 'aneurysm', part: 'dome' }), use('doppler', vessel('pcom')), use('icg', NONE)];

const statusOf = (state: FieldState): string[] => stageViews(state).map((v) => v.status);

describe('the stage table', () => {
  it('has the six stages in order, each with sub-tasks, a hint and a reason', () => {
    expect(STAGES.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(STAGES.map((s) => s.title)).toEqual([
      'Open the sylvian fissure',
      'Identify M1',
      'Identify the carotid and the optic nerve',
      'Confirm the PCom and expose the neck',
      'Clip the aneurysm',
      'Confirm the PCom still flows',
    ]);
    for (const stage of STAGES) {
      expect(stage.why.length).toBeGreaterThan(30);
      expect(stage.tasks.length).toBeGreaterThan(0);
      for (const task of stage.tasks) {
        expect(task.hint.length).toBeGreaterThan(20);
        expect(task.text.length).toBeGreaterThan(5);
      }
    }
    const ids = STAGES.flatMap((s) => s.tasks.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('starts on step 1 with the rest locked and nothing ticked', () => {
    const views = stageViews(initialField());
    expect(views.map((v) => v.status)).toEqual(['current', 'locked', 'locked', 'locked', 'locked', 'locked']);
    expect(views.flatMap((v) => v.tasks).some((t) => t.done)).toBe(false);
    expect(currentStage(initialField())?.stage.number).toBe(1);
  });
});

describe('a scripted learner', () => {
  it('ticks the sub-tasks of step 1 one at a time and then unlocks step 2', () => {
    const cuts = play(initialField(), ...STEP1.slice(0, 3));
    expect(stageViews(cuts.state)[0]!.tasks.map((t) => t.done)).toEqual([true, false]);
    expect(statusOf(cuts.state)[0]).toBe('current');
    const held = play(cuts.state, STEP1[3]!);
    expect(stageViews(held.state)[0]!.tasks.map((t) => t.done)).toEqual([true, true]);
    expect(statusOf(held.state).slice(0, 2)).toEqual(['done', 'current']);
  });

  it('completes steps 1 to 4 and arrives at step 5', () => {
    const { state } = play(initialField(), ...STEP1, ...STEP2, ...STEP3, ...STEP4);
    expect(statusOf(state)).toEqual(['done', 'done', 'done', 'done', 'current', 'locked']);
    expect(currentStage(state)?.stage.number).toBe(5);
    expect(nextTask(state)?.task.id).toBe('clip-on');
  });

  it('completes all six steps with a clean record', () => {
    const { state } = play(initialField(), ...STEP1, ...STEP2, ...STEP3, ...STEP4, ...STEP5, ...STEP6);
    expect(statusOf(state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(allStagesDone(state)).toBe(true);
    expect(currentStage(state)).toBeNull();
    expect(nextTask(state)).toBeNull();
    expect(state.injuries).toEqual([]);
    expect(state.ruptured).toBe(false);
  });

  it('does not un-tick the fissure step when the spatula is released', () => {
    const { state } = play(initialField(), ...STEP1, use('spatula', NONE));
    expect(state.retraction).toBe(0);
    expect(statusOf(state)[0]).toBe('done');
  });

  it('keeps a step locked, however much of it was done early, until the one before is finished', () => {
    const early = play(initialField(), ...STEP2, ...STEP3);
    expect(statusOf(early.state)).toEqual(['current', 'locked', 'locked', 'locked', 'locked', 'locked']);
    expect(stageViews(early.state)[1]!.tasks[0]!.done).toBe(true);
    // Finishing step 1 then runs through the steps already done.
    const through = play(early.state, ...STEP1);
    expect(statusOf(through.state).slice(0, 3)).toEqual(['done', 'done', 'done']);
    expect(currentStage(through.state)?.stage.number).toBe(4);
  });
});

describe('identifying', () => {
  it('records an artery, a nerve or the aneurysm, once each, and says what it is', () => {
    const first = play(initialField(), identify(vessel('m1')), identify(vessel('m1')), identify({ kind: 'aneurysm', part: 'dome' }));
    expect(first.state.identified).toEqual(['m1', 'aneurysm']);
    expect(first.events.map((e) => e.code)).toEqual(['identified', 'identified', 'identified']);
    expect(first.events[0]!.text).toBe('That is: M1 (middle cerebral artery).');
  });

  it('refuses a membrane, a lobe or empty space', () => {
    for (const target of [arach('arach-mid'), { kind: 'lobe', id: 'frontal' } as Target, NONE]) {
      const r = play(initialField(), identify(target));
      expect(r.state.identified).toEqual([]);
      expect(r.events[0]!.code).toBe('noop');
    }
  });

  it('does not tick a task for the wrong structure', () => {
    const { state } = play(initialField(), ...STEP1, identify(vessel('ica')));
    expect(stageViews(state)[1]!.tasks[0]!.done).toBe(false);
    expect(currentStage(state)?.stage.number).toBe(2);
  });
});

describe('the checks after clipping', () => {
  const clipped = (): FieldState => play(initialField(), ...STEP1, ...STEP4.slice(2), use('clip', NECK)).state;

  it('count only once a clip is on and the temporary clip is off', () => {
    expect(play(initialField(), use('doppler', vessel('pcom'))).state.checks).toEqual([]);
    expect(play(initialField(), use('icg', NONE)).state.checks).toEqual([]);
    const withTemp = play(clipped(), use('tempClip', ICA), use('doppler', vessel('pcom')), use('icg', NONE)).state;
    expect(withTemp.checks).toEqual([]);
    const clear = play(clipped(), use('doppler', vessel('pcom')), use('doppler', { kind: 'aneurysm', part: 'dome' }), use('icg', NONE)).state;
    expect([...clear.checks].sort()).toEqual(['icg-checked', 'pcom-flow', 'sac-silent']);
  });

  it('are not ticked by flow in the sac, which means the clip is not on', () => {
    expect(play(initialField(), use('doppler', { kind: 'aneurysm', part: 'dome' })).state.checks).toEqual([]);
  });
});

describe('the mentor', () => {
  it('gives the next hint and the reason for the step, and moves on as steps finish', () => {
    const first = adviceNow(initialField());
    expect(first.eyebrow).toBe('Step 1 of 6');
    expect(first.title).toBe('Open the sylvian fissure');
    expect(first.hint).toContain('scissors');
    expect(first.why).toContain('corridor');
    const later = adviceNow(play(initialField(), ...STEP1).state);
    expect(later.eyebrow).toBe('Step 2 of 6');
    expect(later.title).toContain('M1');
  });

  it('says when everything is done', () => {
    const done = adviceNow(play(initialField(), ...STEP1, ...STEP2, ...STEP3, ...STEP4, ...STEP5, ...STEP6).state);
    expect(done.eyebrow).toBe('All six steps done');
  });

  it('announces each finished step and the next one, once', () => {
    const run = play(initialField(), ...STEP1);
    const texts = run.notes.map((n) => n.text);
    expect(texts.filter((t) => t.startsWith('Step 1 complete'))).toHaveLength(1);
    expect(texts).toContain('Next: step 2, Identify M1.');
  });

  it('announces every step it runs through when an early step finishes last', () => {
    const early = play(initialField(), ...STEP2, ...STEP3);
    expect(early.notes.filter((n) => n.text.includes('complete'))).toHaveLength(0);
    const through = play(early.state, ...STEP1);
    const completes = through.notes.filter((n) => /^Step \d complete/.test(n.text)).map((n) => n.text.slice(0, 6));
    expect(completes).toEqual(['Step 1', 'Step 2', 'Step 3']);
  });

  it('ends with a closing note when the sixth step is done', () => {
    const run = play(initialField(), ...STEP1, ...STEP2, ...STEP3, ...STEP4, ...STEP5, ...STEP6);
    expect(run.notes.at(-1)).toEqual({ tone: 'good', text: 'All six steps are done. Well worked.' });
  });

  it('explains a rupture with the plan, and an injury with its consequence', () => {
    const burst = play(initialField(), use('scissors', { kind: 'aneurysm', part: 'dome' }));
    expect(burst.notes.some((n) => n.tone === 'bad' && n.text.includes('temporary clip'))).toBe(true);
    const cut = play(initialField(), use('scissors', ICA));
    expect(cut.notes.some((n) => n.tone === 'bad' && n.text.includes('debrief'))).toBe(true);
  });

  it('passes on the reason a move was refused', () => {
    const early = play(initialField(), use('scissors', arach('arach-deep')), use('spatula', NONE), use('dissector', NECK));
    expect(early.notes.map((n) => n.tone)).toEqual(['warn', 'warn', 'warn']);
  });

  it('warns once as the dome is strained, and once each as the clocks cross their lines', () => {
    const strain = play(initialField(), ...STEP1, use('dissector', { kind: 'aneurysm', part: 'dome' }), use('dissector', { kind: 'aneurysm', part: 'dome' }));
    expect(strain.notes.filter((n) => n.text.includes('straining the dome'))).toHaveLength(1);

    const temp = play(initialField(), use('tempClip', ICA), { wait: RULES.tempClipWarnSeconds - 1 }, { wait: 2 }, { wait: 2 }, { wait: RULES.tempClipLongSeconds });
    expect(temp.notes.filter((n) => n.tone === 'warn' && n.text.includes('three minutes'))).toHaveLength(1);
    expect(temp.notes.filter((n) => n.tone === 'bad' && n.text.includes('long'))).toHaveLength(1);

    const held = play(initialField(), ...STEP1, { wait: RULES.retractionWarnSeconds - 1 }, { wait: 2 }, { wait: 5 });
    expect(held.notes.filter((n) => n.text.includes('ten minutes'))).toHaveLength(1);
  });

  it('says nothing when nothing notable happened', () => {
    const quiet = play(initialField(), { wait: 5 }, use('icg', NONE));
    expect(quiet.notes).toEqual([]);
  });
});
