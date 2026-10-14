/**
 * The mentor: calm notes for the learner, as pure functions of what just happened. `notesFor` compares the field
 * before and after an action (and the events it produced) and returns what the mentor should say: a step finished,
 * something went wrong and how to think about it, or a clock that has run long. `adviceNow` is the standing hint.
 */
import { RULES } from '../config/rules';
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

/** The standing hint for the first thing left to do, with why the step matters. */
export function adviceNow(state: FieldState): Advice {
  const next = nextTask(state);
  if (!next) {
    return {
      eyebrow: 'All six steps done',
      title: 'The aneurysm is clipped and checked',
      hint: 'The debrief arrives in a later milestone. You can keep exploring.',
      why: 'Clipping, then checking flow in the sac and the neighbouring arteries, is the whole point of the operation.',
    };
  }
  return { eyebrow: `Step ${next.stage.number} of ${STAGES.length}`, title: next.stage.title, hint: next.task.hint, why: next.stage.why };
}

const crossed = (before: number, after: number, line: number): boolean => before < line && after >= line;

/** What the mentor should say about the change from `prev` to `next`, given the events the action produced. */
export function notesFor(prev: FieldState, next: FieldState, events: readonly FieldEvent[]): MentorNote[] {
  const notes: MentorNote[] = [];

  const before = stageViews(prev);
  const after = stageViews(next);
  after.forEach((view, i) => {
    if (view.status === 'done' && before[i]!.status !== 'done') {
      notes.push({ tone: 'good', text: `Step ${view.stage.number} complete: ${view.stage.title}.` });
    }
  });
  const was = currentStage(prev);
  const now = currentStage(next);
  if (was && now && was.stage.number !== now.stage.number) notes.push({ tone: 'info', text: `Next: step ${now.stage.number}, ${now.stage.title}.` });
  if (was && !now) notes.push({ tone: 'good', text: 'All six steps are done. Well worked.' });

  for (const e of events) {
    if (e.code === 'rupture') {
      notes.push({
        tone: 'bad',
        text: 'The aneurysm has ruptured. Stay calm: clear the blood with suction, put a temporary clip on the carotid to slow the bleeding, then clip the neck.',
      });
    } else if (e.code === 'cut-injury' || e.code === 'burned') {
      notes.push({ tone: 'bad', text: `${e.text} Injuries are recorded and will count at the debrief.` });
    } else if (e.code === 'neck-blocked' || e.code === 'bound' || e.code === 'wrong-order' || e.code === 'clip-refused') {
      notes.push({ tone: 'warn', text: e.text });
    }
  }

  if (crossed(prev.domeStress, next.domeStress, 0.6) && !next.ruptured) {
    notes.push({ tone: 'warn', text: 'You are straining the dome. Work on the neck, from the carotid side, not on the dome.' });
  }
  if (next.tempClip.on && crossed(prev.tempClip.seconds, next.tempClip.seconds, RULES.tempClipWarnSeconds)) {
    notes.push({ tone: 'warn', text: 'The temporary clip has been on for three minutes. Plan to release it soon.' });
  }
  if (next.tempClip.on && crossed(prev.tempClip.seconds, next.tempClip.seconds, RULES.tempClipLongSeconds)) {
    notes.push({ tone: 'bad', text: 'Temporary occlusion is now long. Release the clip: the brain beyond it is going without blood.' });
  }
  if (crossed(prev.retractionSeconds, next.retractionSeconds, RULES.retractionWarnSeconds) && next.retraction > 0) {
    notes.push({ tone: 'warn', text: 'The lobes have been held apart for ten minutes. Relax the spatula when you can.' });
  }
  return notes;
}
