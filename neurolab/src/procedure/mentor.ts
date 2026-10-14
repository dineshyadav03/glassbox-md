/**
 * The mentor: calm notes for the learner, as pure functions of what just happened. `notesFor` compares the field
 * before and after an action (and the events it produced) and returns what the mentor should say: a step finished,
 * something went wrong and how to think about it, or a clock that has run long. `adviceNow` is the standing hint.
 */
import { RULES } from '../config/rules';
import { t } from '../i18n';
import type { FieldEvent, FieldState } from './field';
import { STAGES, currentStage, nextTask, stageViews } from './stages';

export interface MentorNote {
  readonly tone: 'info' | 'good' | 'warn' | 'bad';
  readonly text: string;
}

export interface Advice {
  /** "Step 2 of 6" or "Done". */
  readonly eyebrow: string;
  readonly title: string;
  readonly hint: string;
  readonly why: string;
}

/** What the learner has found wrong with the clip so far (only what they have checked), as advice, or null. */
function clipProblem(state: FieldState): string | null {
  if (state.checks.includes('sac-fills')) {
    return t('mn.sacFills');
  }
  if (state.checks.includes('pcom-silent')) {
    return t('mn.pcomSilent');
  }
  if (state.checks.includes('ica-narrowed')) {
    return t('mn.icaNarrowed');
  }
  return null;
}

/** The standing hint for the first thing left to do, with why the step matters. */
export function adviceNow(state: FieldState): Advice {
  const next = nextTask(state);
  const problem = state.clip && !state.tempClip.on ? clipProblem(state) : null;
  if (problem && next && next.stage.number === 6) {
    return { eyebrow: t('mn.eyebrow', { n: next.stage.number, total: STAGES.length }), title: next.stage.title, hint: problem, why: next.stage.why };
  }
  if (!next) {
    return { eyebrow: t('mn.doneEyebrow'), title: t('mn.doneTitle'), hint: t('mn.doneHint'), why: t('mn.doneWhy') };
  }
  return { eyebrow: t('mn.eyebrow', { n: next.stage.number, total: STAGES.length }), title: next.stage.title, hint: next.task.hint, why: next.stage.why };
}

const crossed = (before: number, after: number, line: number): boolean => before < line && after >= line;

/** What the mentor should say about the change from `prev` to `next`, given the events the action produced. */
export function notesFor(prev: FieldState, next: FieldState, events: readonly FieldEvent[]): MentorNote[] {
  const notes: MentorNote[] = [];

  const before = stageViews(prev);
  const after = stageViews(next);
  after.forEach((view, i) => {
    if (view.status === 'done' && before[i]!.status !== 'done') {
      notes.push({ tone: 'good', text: t('mn.stepComplete', { n: view.stage.number, title: view.stage.title }) });
    }
  });
  const was = currentStage(prev);
  const now = currentStage(next);
  if (was && now && was.stage.number !== now.stage.number) notes.push({ tone: 'info', text: t('mn.next', { n: now.stage.number, title: now.stage.title }) });
  if (was && !now) notes.push({ tone: 'good', text: t('mn.allDone') });

  for (const e of events) {
    if (e.code === 'rupture') {
      notes.push({
        tone: 'bad',
        text: t('mn.rupture'),
      });
    } else if (e.code === 'cut-injury' || e.code === 'burned') {
      notes.push({ tone: 'bad', text: t('mn.injury', { text: e.text }) });
    } else if (e.code === 'neck-blocked' || e.code === 'obstructed' || e.code === 'bound' || e.code === 'wrong-order' || e.code === 'clip-refused') {
      notes.push({ tone: 'warn', text: e.text });
    }
  }

  if (crossed(prev.domeStress, next.domeStress, 0.6) && !next.ruptured) {
    notes.push({ tone: 'warn', text: t('mn.strain') });
  }
  const below = (before: number, after: number, line: number): boolean => before >= line && after < line;
  if (below(prev.vitals.sbp, next.vitals.sbp, RULES.vitals.lowSbp)) {
    notes.push({ tone: 'bad', text: t('mn.bp') });
  }
  if (below(prev.vitals.mep, next.vitals.mep, RULES.vitals.lowMep)) {
    notes.push({ tone: 'bad', text: t('mn.mep') });
  }
  if (next.tempClip.on && crossed(prev.tempClip.seconds, next.tempClip.seconds, RULES.tempClipWarnSeconds)) {
    notes.push({ tone: 'warn', text: t('mn.temp3') });
  }
  if (next.tempClip.on && crossed(prev.tempClip.seconds, next.tempClip.seconds, RULES.tempClipLongSeconds)) {
    notes.push({ tone: 'bad', text: t('mn.tempLong') });
  }
  if (crossed(prev.retractionSeconds, next.retractionSeconds, RULES.retractionWarnSeconds) && next.retraction > 0) {
    notes.push({ tone: 'warn', text: t('mn.retraction') });
  }
  return notes;
}
