import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/rules';
import { DemoRunner, demoPlan } from '../src/demo/autopilot';
import { EN } from '../src/i18n/en';
import { t, type MessageKey } from '../src/i18n';
import { goodClip } from '../src/physics/clipEval';
import { NO_CLIP_CAP, WEIGHTS, debrief, gradeFor, summarise, type CaseSummary } from '../src/procedure/debrief';
import { act, initialField, tick, type Action, type FieldState, type Target } from '../src/procedure/field';
import { allStagesDone } from '../src/procedure/stages';
import type { ToolId } from '../src/tools/tools';

const NONE: Target = { kind: 'none' };
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const DOME: Target = { kind: 'aneurysm', part: 'dome' };
const ICA: Target = { kind: 'vessel', id: 'ica' };
const use = (tool: ToolId, target: Target): Action => ({ type: 'click', tool, target });

/** Play the demo's plan against the engine at 30 frames a second, as the screen would. */
function playDemo(seconds = 600): FieldState {
  const runner = new DemoRunner();
  let state = initialField();
  const dt = 1 / 30;
  for (let t0 = 0; t0 < seconds && !runner.done; t0 += dt) {
    state = tick(state, dt);
    for (const action of runner.step(dt).actions) state = act(state, action).state;
  }
  return state;
}

const baseSummary: CaseSummary = {
  seconds: 300,
  eblMl: 20,
  tempClipTotalSeconds: 30,
  retractionSeconds: 200,
  ruptured: false,
  injuries: 0,
  clip: { closed: true, residualMm: 0, icaNarrowingPct: 0, pcomOpen: true, achoaOpen: true, angleErrorDeg: 1 },
  stepsDone: 6,
  stepsTotal: 6,
  mepMin: 100,
  controlled: true,
};

describe('the weights', () => {
  it('add up to a hundred', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('grade a score in steps', () => {
    expect(gradeFor(100)).toBe('excellent');
    expect(gradeFor(90)).toBe('excellent');
    expect(gradeFor(89)).toBe('good');
    expect(gradeFor(75)).toBe('good');
    expect(gradeFor(60)).toBe('fair');
    expect(gradeFor(54)).toBe('needsWork');
  });
});

describe('the debrief', () => {
  it('gives a clean case 100 and Excellent, with a clean-case tip', () => {
    const d = debrief(baseSummary);
    expect(d.score).toBe(100);
    expect(d.grade).toBe('excellent');
    expect(d.gradeLabel).toBe('Excellent');
    expect(d.tips).toEqual([EN['tip.clean']]);
    expect(d.items.every((i) => i.points === i.max)).toBe(true);
  });

  it('marks a rupture down, more if it was never controlled, and says how to handle one', () => {
    const controlled = debrief({ ...baseSummary, ruptured: true, eblMl: 250, injuries: 0 });
    const free = debrief({ ...baseSummary, ruptured: true, controlled: false, clip: null, eblMl: 900, stepsDone: 5 });
    expect(controlled.score).toBeLessThan(100);
    expect(controlled.grade).not.toBe('needsWork');
    expect(controlled.tips.join(' ')).toContain('suction, temporary clip, then clip');
    expect(free.score).toBeLessThan(controlled.score);
    expect(free.grade).toBe('needsWork');
    expect(free.tips.join(' ')).toContain('never controlled');
  });

  it('marks a bad clip by what is wrong with it', () => {
    const open = debrief({ ...baseSummary, clip: { ...baseSummary.clip!, closed: false, residualMm: 1.4 }, controlled: false });
    expect(open.items.find((i) => i.id === 'clip')!.points).toBeLessThan(35);
    expect(open.items.find((i) => i.id === 'clip')!.value).toContain('1.4 mm');
    expect(open.grade).not.toBe('excellent');
    expect(open.tips.join(' ')).toContain('not fully closed');

    const pinched = debrief({ ...baseSummary, clip: { ...baseSummary.clip!, pcomOpen: false } });
    expect(pinched.items.find((i) => i.id === 'clip')!.points).toBe(30);
    expect(pinched.tips.join(' ')).toContain('posterior communicating');

    const narrowed = debrief({ ...baseSummary, clip: { ...baseSummary.clip!, icaNarrowingPct: 50 } });
    expect(narrowed.items.find((i) => i.id === 'clip')!.points).toBe(30);
    expect(narrowed.tips.join(' ')).toContain('narrowed');

    const none = debrief({ ...baseSummary, clip: null, controlled: false, stepsDone: 4 });
    expect(none.items.find((i) => i.id === 'clip')!.points).toBe(0);
    expect(none.tips.join(' ')).toContain('No clip was placed');
  });

  it('marks a too-long temporary clip down in steps, and warns', () => {
    const points = (seconds: number): number => debrief({ ...baseSummary, tempClipTotalSeconds: seconds }).items.find((i) => i.id === 'temp')!.points;
    expect(points(0)).toBe(10);
    expect(points(120)).toBe(10);
    expect(points(RULES.tempClipWarnSeconds)).toBe(7);
    expect(points(RULES.tempClipLongSeconds)).toBe(3);
    expect(points(RULES.tempClipLongSeconds + 1)).toBe(0);
    expect(debrief({ ...baseSummary, tempClipTotalSeconds: 400 }).tips.join(' ')).toContain('temporary clip was on for too long');
  });

  it('takes five points off for each injury, and counts blood loss, steps and retraction', () => {
    expect(debrief({ ...baseSummary, injuries: 1 }).items.find((i) => i.id === 'injuries')!.points).toBe(5);
    expect(debrief({ ...baseSummary, injuries: 5 }).items.find((i) => i.id === 'injuries')!.points).toBe(0);
    expect(debrief({ ...baseSummary, eblMl: 500 }).items.find((i) => i.id === 'blood')!.points).toBe(4);
    expect(debrief({ ...baseSummary, stepsDone: 3 }).items.find((i) => i.id === 'steps')!.points).toBe(5);
    expect(debrief({ ...baseSummary, retractionSeconds: 700 }).items.find((i) => i.id === 'retraction')!.points).toBe(2);
  });

  it('gives an untouched case Needs work, with every tip that applies', () => {
    const d = debrief(summarise(initialField()));
    expect(d.grade).toBe('needsWork');
    expect(d.tips.join(' ')).toContain('No clip');
    expect(d.tips.join(' ')).toContain('Not every step');
    expect(d.score).toBeLessThanOrEqual(NO_CLIP_CAP);
  });

  it('summarises the state: it counts injuries but not the rupture itself, and a closed clip as control', () => {
    const burst = act(initialField(), use('scissors', DOME)).state;
    expect(burst.injuries).toHaveLength(1);
    expect(summarise(burst).injuries).toBe(0);
    expect(summarise(burst).ruptured).toBe(true);
    expect(summarise(burst).controlled).toBe(false);
    const cut = act(initialField(), use('scissors', ICA)).state;
    expect(summarise(cut).injuries).toBe(1);
  });
});

describe('the demo', () => {
  it('performs the whole case with a clean record and ends on an Excellent debrief', () => {
    const state = playDemo();
    expect(allStagesDone(state)).toBe(true);
    expect(state.ruptured).toBe(false);
    expect(state.injuries).toEqual([]);
    expect(state.clip).toEqual({ ...goodClip(), appliedAt: state.clip!.appliedAt });
    const d = debrief(summarise(state));
    expect(d.grade).toBe('excellent');
    expect(d.score).toBeGreaterThanOrEqual(95);
  });

  it('finishes in a sensible time, whatever the frame rate', () => {
    for (const fps of [10, 30, 120]) {
      const runner = new DemoRunner();
      let state = initialField();
      let elapsed = 0;
      while (!runner.done && elapsed < 600) {
        const dt = 1 / fps;
        state = tick(state, dt);
        for (const action of runner.step(dt).actions) state = act(state, action).state;
        elapsed += dt;
      }
      expect(runner.done, `${fps} fps`).toBe(true);
      expect(elapsed).toBeGreaterThan(30);
      expect(elapsed).toBeLessThan(120);
      expect(allStagesDone(state), `${fps} fps`).toBe(true);
    }
  });

  it('survives a very long frame, running several steps at once, and then reports it is finished', () => {
    const runner = new DemoRunner();
    const out = runner.step(1000);
    expect(out.finished).toBe(true);
    expect(runner.step(1).actions).toEqual([]);
    expect(runner.done).toBe(true);
  });

  it('narrates with keys that exist, and names a tool for each held step', () => {
    for (const step of demoPlan()) {
      if (step.narration) {
        expect(EN[step.narration]).toBeTruthy();
      }
      if (step.hold) expect(step.tool ?? 'previous').toBeTruthy();
    }
    expect(demoPlan().filter((s) => s.narration).length).toBeGreaterThan(8);
  });

  it('emits the held tool with each frame of a hold, summing to the hold time', () => {
    const runner = new DemoRunner();
    let held = 0;
    let tools = new Set<string>();
    for (let i = 0; i < 20000 && !runner.done; i++) {
      for (const a of runner.step(0.02).actions) {
        if (a.type === 'hold') {
          held += a.dt;
          tools.add(a.tool);
        }
      }
    }
    expect([...tools].sort()).toEqual(['bipolar', 'doppler']);
    expect(held).toBeCloseTo(RULES.coagulateSeconds + 0.4 + 1.6 + 1.6, 1);
  });
});

describe('the sentences', () => {
  it('are all filled in, and every {placeholder} is a plain name', () => {
    for (const key of Object.keys(EN) as MessageKey[]) {
      expect(EN[key].length, key).toBeGreaterThan(0);
      for (const match of EN[key].matchAll(/\{([^}]*)\}/g)) expect(match[1], key).toMatch(/^\w+$/);
    }
  });

  it('fill in placeholders, and leave one that was not given as written', () => {
    expect(t('mn.stepComplete', { n: 2, title: 'M1' })).toBe('Step 2 complete: M1.');
    expect(t('ev.identified', {})).toBe('That is: {name}.');
    expect(t('ev.sealed')).toBe('Sealed.');
  });

  it('keep the educational-only wording on the start screen', () => {
    for (const phrase of ['not clinical training', 'not a medical device', 'not medical advice', 'invented']) expect(EN['start.disclaimer']).toContain(phrase);
  });
});

void NONE;
void NECK;
