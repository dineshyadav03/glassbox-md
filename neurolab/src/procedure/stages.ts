/**
 * The six stages of the case and their sub-tasks, as pure functions of the field state. A stage is complete when all its
 * sub-tasks are; the current stage is the first that is not, and later ones are locked until it is. Every sub-task reads
 * something the state already remembers (what was cut, the most the fissure was opened, what was identified, the checks
 * made after clipping), so stepping back never un-ticks a step except taking the clip off.
 *
 * The words (titles, reasons, task texts and hints) live in the sentence table under `stage.N.*` and `task.ID.*`;
 * the getters here read them from there.
 */
import { RULES } from '../config/rules';
import { t, type MessageKey } from '../i18n';
import type { FieldState } from './field';

export interface SubTask {
  readonly id: string;
  /** What the learner has to do, as a short sentence for the checklist. */
  readonly text: string;
  /** The calm next-step hint shown by the mentor while this is the first thing left to do. */
  readonly hint: string;
  done(state: FieldState): boolean;
}

export interface Stage {
  readonly number: number;
  readonly title: string;
  /** Why this step matters, shown by the mentor. */
  readonly why: string;
  readonly tasks: readonly SubTask[];
}

function task(id: string, done: (state: FieldState) => boolean): SubTask {
  return {
    id,
    done,
    get text(): string {
      return t(`task.${id}.text` as MessageKey);
    },
    get hint(): string {
      return t(`task.${id}.hint` as MessageKey);
    },
  };
}

function stage(number: number, tasks: readonly SubTask[]): Stage {
  return {
    number,
    tasks,
    get title(): string {
      return t(`stage.${number}.title` as MessageKey);
    },
    get why(): string {
      return t(`stage.${number}.why` as MessageKey);
    },
  };
}

const fissureCut = (s: FieldState): boolean => RULES.arachnoidOrder.slice(0, RULES.fissureSegmentCount).every((id) => s.cut.includes(id));

export const STAGES: readonly Stage[] = [
  stage(1, [task('cut-fissure', fissureCut), task('hold-open', (s) => s.peakRetraction >= 1)]),
  stage(2, [task('identify-m1', (s) => s.identified.includes('m1'))]),
  stage(3, [task('identify-ica', (s) => s.identified.includes('ica')), task('identify-optic', (s) => s.identified.includes('optic'))]),
  stage(4, [
    task('identify-pcom', (s) => s.identified.includes('pcom')),
    task('identify-achoa', (s) => s.identified.includes('achoa')),
    task('cut-cistern', (s) => s.cut.includes(RULES.arachnoidOrder[RULES.arachnoidOrder.length - 1]!)),
    task('free-neck', (s) => s.neckFreed >= RULES.neckFreedForClip),
  ]),
  stage(5, [task('clip-on', (s) => s.clip !== null)]),
  stage(6, [
    task('sac-silent', (s) => s.checks.includes('sac-silent')),
    task('pcom-flow', (s) => s.checks.includes('pcom-flow')),
    task('icg-checked', (s) => s.checks.includes('icg-checked')),
  ]),
];

export type StageStatus = 'done' | 'current' | 'locked';

export interface StageView {
  readonly stage: Stage;
  readonly status: StageStatus;
  readonly tasks: readonly { readonly task: SubTask; readonly done: boolean }[];
}

/** Each stage with its status and which sub-tasks are ticked. */
export function stageViews(state: FieldState): StageView[] {
  let seenCurrent = false;
  return STAGES.map((s) => {
    const tasks = s.tasks.map((item) => ({ task: item, done: item.done(state) }));
    const complete = tasks.every((item) => item.done);
    let status: StageStatus;
    if (seenCurrent) status = 'locked';
    else if (complete) status = 'done';
    else {
      status = 'current';
      seenCurrent = true;
    }
    return { stage: s, status, tasks };
  });
}

/** The stage the learner is on, or null once all six are done. */
export function currentStage(state: FieldState): StageView | null {
  return stageViews(state).find((v) => v.status === 'current') ?? null;
}

export function allStagesDone(state: FieldState): boolean {
  return currentStage(state) === null;
}

/** The first sub-task still to do in the current stage, or null when everything is done. */
export function nextTask(state: FieldState): { stage: Stage; task: SubTask } | null {
  const current = currentStage(state);
  const left = current?.tasks.find((item) => !item.done);
  return current && left ? { stage: current.stage, task: left.task } : null;
}
