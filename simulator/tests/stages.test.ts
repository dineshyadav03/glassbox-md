import { describe, expect, it } from 'vitest';
import {
  NO_FACTS,
  STAGES,
  TOOL_ORDER,
  advanceProgress,
  currentStageIndex,
  initialProgress,
  isProcedureComplete,
  nextHint,
  overallProgress,
  stageProgress,
  toolAvailability,
  type ProcedureFacts,
  type Progress,
  type ToolId,
} from '../src/procedure/stages';

const facts = (overrides: Partial<ProcedureFacts>): ProcedureFacts => ({ ...NO_FACTS, ...overrides });

const STAGE_1 = { guidePastElbow: true, guideInAorta: true, fluoroUsedPastElbow: true, guideAtRoot: true };
const STAGE_2 = { guideFacedLeftCusp: true, guideEngagedNow: true, diagnosticAngiogram: true };
const STAGE_3 = { heparinGiven: true, wireOut: true, wireReachedLad: true, wireCrossedLesion: true, wireParkedDistally: true, wireBeyondLesionNow: true };
const STAGE_4 = { balloonAcrossLesion: true, balloonInflatedOverLesion: true, balloonDeflatedAfter: true };
const STAGE_5 = { qcaMeasured: true, stentLoaded: true, stentCoversLesion: true, stentDeployedAndDeflated: true };
const STAGE_6 = { angiogramAfterStent: true, distinctProjectionsAfterStent: 2 };

/** Facts for a learner who has finished stages 1..n. */
function through(n: number): ProcedureFacts {
  const all = [STAGE_1, STAGE_2, STAGE_3, STAGE_4, STAGE_5, STAGE_6];
  return facts(Object.assign({}, ...all.slice(0, n)));
}

describe('the stages', () => {
  it('are the specified six, in order, with the specified sub-tasks', () => {
    expect(STAGES.map((s) => s.title)).toEqual([
      'Advance the guide to the aortic root',
      'Engage the left main',
      'Cross the LAD lesion',
      'Pre-dilate',
      'Deploy the stent',
      'Final angiogram',
    ]);
    expect(STAGES.map((s) => s.subtasks.length)).toEqual([4, 3, 5, 3, 4, 2]);
  });

  it('give every stage a goal, a "why" note and a hint for every sub-task, with unique ids', () => {
    const ids = STAGES.flatMap((s) => s.subtasks.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const stage of STAGES) {
      expect(stage.goal.length).toBeGreaterThan(20);
      expect(stage.why.length).toBeGreaterThan(20);
      for (const task of stage.subtasks) {
        expect(task.label.length).toBeGreaterThan(3);
        expect(task.hint.length).toBeGreaterThan(10);
      }
    }
  });

  it('list the seven tools in the order of the number keys', () => {
    expect(TOOL_ORDER).toEqual(['guide', 'wire', 'balloon', 'stent', 'contrast', 'fluoro', 'measure']);
  });
});

describe('progression', () => {
  it('starts at stage 1 with nothing done', () => {
    const p = initialProgress();
    expect(currentStageIndex(p)).toBe(0);
    expect(overallProgress(p)).toBe(0);
    expect(stageProgress(p)).toBe(0);
    expect(isProcedureComplete(p)).toBe(false);
  });

  it('does not move on with no facts', () => {
    expect(advanceProgress(initialProgress(), NO_FACTS, 5)).toEqual({ latched: {}, completedAt: [null, null, null, null, null, null] });
  });

  it('latches sub-tasks one by one and reports the fraction of the stage', () => {
    let p = advanceProgress(initialProgress(), facts({ guidePastElbow: true }), 10);
    expect(p.latched['s1.past-elbow']).toBe(true);
    expect(stageProgress(p)).toBeCloseTo(0.25);
    p = advanceProgress(p, facts({ guidePastElbow: true, guideInAorta: true }), 20);
    expect(stageProgress(p)).toBeCloseTo(0.5);
    expect(currentStageIndex(p)).toBe(0);
  });

  it('keeps a sub-task done after its condition stops being true', () => {
    let p = advanceProgress(initialProgress(), facts({ guidePastElbow: true }), 10);
    p = advanceProgress(p, NO_FACTS, 20);
    expect(p.latched['s1.past-elbow']).toBe(true);
  });

  it('completes a stage when every sub-task is latched, recording when', () => {
    const p = advanceProgress(initialProgress(), through(1), 42);
    expect(currentStageIndex(p)).toBe(1);
    expect(p.completedAt[0]).toBe(42);
    expect(p.completedAt[1]).toBeNull();
  });

  it('does not latch a later stage early, even if its facts are already true', () => {
    const p = advanceProgress(initialProgress(), facts({ ...STAGE_2, guidePastElbow: true }), 5);
    expect(currentStageIndex(p)).toBe(0);
    expect(p.latched['s2.seated']).toBeUndefined();
    expect(p.latched['s2.angiogram']).toBeUndefined();
  });

  it('chains into the next stage in the same step when its facts are already true', () => {
    const p = advanceProgress(initialProgress(), through(3), 99);
    expect(currentStageIndex(p)).toBe(3);
    expect(p.completedAt.slice(0, 3)).toEqual([99, 99, 99]);
  });

  it('keeps the first completion time when advanced again', () => {
    let p = advanceProgress(initialProgress(), through(1), 42);
    p = advanceProgress(p, through(2), 80);
    expect(p.completedAt[0]).toBe(42);
    expect(p.completedAt[1]).toBe(80);
  });

  it('finishes the whole case', () => {
    let p = initialProgress();
    for (let n = 1; n <= 6; n++) p = advanceProgress(p, through(n), n * 10);
    expect(isProcedureComplete(p)).toBe(true);
    expect(currentStageIndex(p)).toBe(6);
    expect(overallProgress(p)).toBe(1);
    expect(stageProgress(p)).toBe(1);
    expect(p.completedAt).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('needs two distinct final projections', () => {
    let p = advanceProgress(initialProgress(), through(5), 1);
    p = advanceProgress(p, facts({ ...through(5), angiogramAfterStent: true, distinctProjectionsAfterStent: 1 }), 2);
    expect(isProcedureComplete(p)).toBe(false);
    p = advanceProgress(p, facts({ ...through(5), angiogramAfterStent: true, distinctProjectionsAfterStent: 2 }), 3);
    expect(isProcedureComplete(p)).toBe(true);
  });

  it('is idempotent and does not mutate its input', () => {
    const start = Object.freeze(initialProgress());
    const once = advanceProgress(start, through(2), 7);
    expect(advanceProgress(once, through(2), 7)).toEqual(once);
    expect(start.latched).toEqual({});
  });

  it('keeps overall progress between 0 and 1 as it grows', () => {
    let previous = 0;
    let p: Progress = initialProgress();
    for (let n = 0; n <= 6; n++) {
      p = advanceProgress(p, through(n), n);
      expect(overallProgress(p)).toBeGreaterThanOrEqual(previous);
      previous = overallProgress(p);
    }
    expect(previous).toBe(1);
  });
});

describe('the mentor hint', () => {
  it('points at the first undone sub-task of the current stage', () => {
    expect(nextHint(initialProgress())).toBe(STAGES[0]!.subtasks[0]!.hint);
    const p = advanceProgress(initialProgress(), facts({ guidePastElbow: true }), 1);
    expect(nextHint(p)).toBe(STAGES[0]!.subtasks[1]!.hint);
  });

  it('moves to the next stage once one is done, and says so at the end', () => {
    expect(nextHint(advanceProgress(initialProgress(), through(1), 1))).toBe(STAGES[1]!.subtasks[0]!.hint);
    expect(nextHint(advanceProgress(initialProgress(), through(6), 1))).toMatch(/debrief/i);
  });
});

describe('tool unlocks', () => {
  const avail = (tool: ToolId, f: ProcedureFacts, p: Progress = initialProgress()) => toolAvailability(tool, p, f);

  it('keeps the guide and the fluoro pedal always available', () => {
    expect(avail('guide', NO_FACTS).available).toBe(true);
    expect(avail('fluoro', NO_FACTS).available).toBe(true);
  });

  it('needs the guide in the aorta before contrast', () => {
    const closed = avail('contrast', NO_FACTS);
    expect(closed.available).toBe(false);
    expect(closed.reason).toMatch(/aorta/);
    expect(avail('contrast', facts({ guideInAorta: true })).available).toBe(true);
  });

  it('needs an angiogram before measuring', () => {
    expect(avail('measure', NO_FACTS).reason).toMatch(/angiogram/);
    expect(avail('measure', facts({ diagnosticAngiogram: true })).available).toBe(true);
  });

  it('needs the guide seated, an angiogram and heparin before the wire, and says which is missing first', () => {
    expect(avail('wire', NO_FACTS).reason).toMatch(/Seat the guide/);
    expect(avail('wire', facts({ guideEngagedNow: true })).reason).toMatch(/angiogram/);
    expect(avail('wire', facts({ guideEngagedNow: true, diagnosticAngiogram: true })).reason).toMatch(/heparin/i);
    expect(avail('wire', facts({ guideEngagedNow: true, diagnosticAngiogram: true, heparinGiven: true })).available).toBe(true);
  });

  it('keeps the wire available once it is out, even if the guide slips', () => {
    expect(avail('wire', facts({ wireOut: true })).available).toBe(true);
  });

  it('needs the wire beyond the lesion before the balloon', () => {
    expect(avail('balloon', NO_FACTS).reason).toMatch(/wire/);
    expect(avail('balloon', facts({ wireBeyondLesionNow: true })).available).toBe(true);
  });

  it('allows only one balloon catheter out at a time', () => {
    const both = facts({ wireBeyondLesionNow: true });
    const withStentOut = avail('balloon', { ...both, stentCatheterOut: true });
    expect(withStentOut.available).toBe(false);
    expect(withStentOut.reason).toMatch(/one balloon catheter/);
    const done = advanceProgress(initialProgress(), through(4), 1);
    const withBalloonOut = toolAvailability('stent', done, { ...through(4), balloonCatheterOut: true });
    expect(withBalloonOut.available).toBe(false);
    expect(withBalloonOut.reason).toMatch(/only one/);
  });

  it('keeps a catheter that is already out available, so it can be managed', () => {
    expect(avail('balloon', facts({ balloonCatheterOut: true })).available).toBe(true);
    expect(avail('stent', facts({ stentCatheterOut: true })).available).toBe(true);
  });

  it('needs pre-dilation, the balloon out of the patient and the wire across before the stent', () => {
    const early = avail('stent', facts({ wireBeyondLesionNow: true }));
    expect(early.available).toBe(false);
    expect(early.reason).toMatch(/Pre-dilate/);

    const afterPredilation = advanceProgress(initialProgress(), through(4), 1);
    expect(toolAvailability('stent', afterPredilation, facts({ wireBeyondLesionNow: true })).available).toBe(true);
    expect(toolAvailability('stent', afterPredilation, facts({ wireBeyondLesionNow: false })).reason).toMatch(/wire/);
  });

  it('gives a reason for every locked tool and none for an available one', () => {
    for (const tool of TOOL_ORDER) {
      const a = avail(tool, NO_FACTS);
      expect(a.available).toBe(a.reason === null);
    }
  });
});
