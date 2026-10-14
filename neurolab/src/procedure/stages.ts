/**
 * The six stages of the case and their sub-tasks, as pure functions of the field state. A stage is complete when all its
 * sub-tasks are; the current stage is the first that is not, and later ones are locked until it is. Every sub-task reads
 * something the state already remembers (what was cut, the most the fissure was opened, what was identified, the checks
 * made after clipping), so stepping back never un-ticks a step except taking the clip off.
 */
import { RULES } from '../config/rules';
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

const fissureCut = (s: FieldState): boolean => RULES.arachnoidOrder.slice(0, RULES.fissureSegmentCount).every((id) => s.cut.includes(id));

export const STAGES: readonly Stage[] = [
  {
    number: 1,
    title: 'Open the sylvian fissure',
    why: 'The fissure is the natural corridor between the frontal and temporal lobes. Opening it lets you reach the deep vessels without cutting brain.',
    tasks: [
      {
        id: 'cut-fissure',
        text: 'Cut the three membrane layers across the fissure',
        hint: 'Pick the scissors (2) and click the outer membrane. Cut one layer at a time, outer first: the deeper ones are reached through it.',
        done: fissureCut,
      },
      {
        id: 'hold-open',
        text: 'Hold the lobes apart with the spatula',
        hint: 'Pick the spatula (5) and click to hold the lobes apart. It opens as far as the cut membrane allows.',
        done: (s) => s.peakRetraction >= 1,
      },
    ],
  },
  {
    number: 2,
    title: 'Identify M1',
    why: 'M1 is the first part of the middle cerebral artery. Following it inward is the safest way to find the carotid and the aneurysm.',
    tasks: [
      {
        id: 'identify-m1',
        text: 'Point at M1 and identify it',
        hint: 'Find the artery running outward along the fissure, point at it and press I (or use Identify).',
        done: (s) => s.identified.includes('m1'),
      },
    ],
  },
  {
    number: 3,
    title: 'Identify the carotid and the optic nerve',
    why: 'The carotid is where the aneurysm arises and where proximal control goes. The optic nerve lies beside it and must not be injured.',
    tasks: [
      {
        id: 'identify-ica',
        text: 'Identify the internal carotid artery',
        hint: 'Follow M1 inward to the large artery it springs from, point at it and press I.',
        done: (s) => s.identified.includes('ica'),
      },
      {
        id: 'identify-optic',
        text: 'Identify the optic nerve',
        hint: 'The pale cord beside the carotid is the optic nerve. Point at it and press I.',
        done: (s) => s.identified.includes('optic'),
      },
    ],
  },
  {
    number: 4,
    title: 'Confirm the PCom and expose the neck',
    why: 'The posterior communicating and anterior choroidal arteries lie right beside the neck. A clip that blocks either can cause harm, so know where they are before you dissect.',
    tasks: [
      {
        id: 'identify-pcom',
        text: 'Identify the posterior communicating artery',
        hint: 'A thin artery leaves the carotid beside the aneurysm and runs backward. Point at it and press I.',
        done: (s) => s.identified.includes('pcom'),
      },
      {
        id: 'identify-achoa',
        text: 'Identify the anterior choroidal artery',
        hint: 'Just beyond it, a very small branch leaves the carotid. Point at it and press I.',
        done: (s) => s.identified.includes('achoa'),
      },
      {
        id: 'cut-cistern',
        text: 'Cut the membrane over the carotid',
        hint: 'Use the scissors on the last membrane, the one lying over the carotid and the aneurysm.',
        done: (s) => s.cut.includes(RULES.arachnoidOrder[RULES.arachnoidOrder.length - 1]!),
      },
      {
        id: 'free-neck',
        text: 'Free the aneurysm neck with the dissector',
        hint: 'Pick the dissector (4) and click the neck, the part of the sac nearest the carotid. Keep off the dome. Seal any ooze with the bipolar (3).',
        done: (s) => s.neckFreed >= RULES.neckFreedForClip,
      },
    ],
  },
  {
    number: 5,
    title: 'Clip the aneurysm',
    why: 'The clip closes the neck and takes the sac out of the circulation while keeping the parent artery open.',
    tasks: [
      {
        id: 'clip-on',
        text: 'Apply the clip across the neck',
        hint: 'Pick the clip (6), turn it with A and D and set its depth with W and S, then click the freed neck. A temporary clip on the carotid (0) first slows bleeding, but keep an eye on its clock.',
        done: (s) => s.clip !== null,
      },
    ],
  },
  {
    number: 6,
    title: 'Confirm the PCom still flows',
    why: 'A clip can look right and still pinch a branch. Listening and looking after clipping is how you know the sac is closed and the neighbouring arteries are open.',
    tasks: [
      {
        id: 'sac-silent',
        text: 'Doppler: the aneurysm is silent',
        hint: 'Release the temporary clip if it is on. Pick the Doppler (8) and hold it on the aneurysm: silence means it is no longer filling.',
        done: (s) => s.checks.includes('sac-silent'),
      },
      {
        id: 'pcom-flow',
        text: 'Doppler: the PCom still has flow',
        hint: 'Hold the Doppler on the posterior communicating artery: a pulsing tone means it is open.',
        done: (s) => s.checks.includes('pcom-flow'),
      },
      {
        id: 'icg-checked',
        text: 'Look at the vessels with ICG',
        hint: 'Pick ICG (7) to see which vessels fill. The sac should stay dark and the neighbouring arteries should glow.',
        done: (s) => s.checks.includes('icg-checked'),
      },
    ],
  },
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
  return STAGES.map((stage) => {
    const tasks = stage.tasks.map((task) => ({ task, done: task.done(state) }));
    const complete = tasks.every((t) => t.done);
    let status: StageStatus;
    if (seenCurrent) status = 'locked';
    else if (complete) status = 'done';
    else {
      status = 'current';
      seenCurrent = true;
    }
    return { stage, status, tasks };
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
  const left = current?.tasks.find((t) => !t.done);
  return current && left ? { stage: current.stage, task: left.task } : null;
}
