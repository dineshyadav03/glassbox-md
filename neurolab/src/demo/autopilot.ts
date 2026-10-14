/**
 * The demo: a script that performs the whole case through the same actions a learner uses, with narration. It is pure:
 * `DemoRunner.step(dt)` says what to do now (select a tool, say a sentence, move the camera, apply actions), and the
 * screen carries it out with the same code as a mouse click. Taking over simply stops asking the runner for more.
 */
import { RULES } from '../config/rules';
import type { MessageKey } from '../i18n';
import { goodClip } from '../physics/clipEval';
import type { Action, Target } from '../procedure/field';
import type { ToolId } from '../tools/tools';

export type CameraShot = 'overview' | 'neck';

export interface DemoStep {
  readonly narration?: MessageKey;
  readonly tool?: ToolId;
  readonly camera?: CameraShot;
  /** Applied once when the step starts. */
  readonly actions?: readonly Action[];
  /** Applied every frame for this long (the held tools: bipolar, Doppler). */
  readonly hold?: { readonly target: Target; readonly seconds: number };
  /** Seconds to wait, after the step's actions and hold, before the next step. */
  readonly pause: number;
}

const NONE: Target = { kind: 'none' };
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const ICA: Target = { kind: 'vessel', id: 'ica' };
const cut = (id: string): Action => ({ type: 'click', tool: 'scissors', target: { kind: 'arachnoid', id } });
const identify = (target: Target): Action => ({ type: 'identify', target });
const dissect: Action = { type: 'click', tool: 'dissector', target: NECK };

export function demoPlan(): readonly DemoStep[] {
  const [lateral, mid, deep, cistern] = RULES.arachnoidOrder as [string, string, string, string];
  return [
    { narration: 'narr.start', tool: 'scissors', camera: 'overview', actions: [cut(lateral)], pause: 2.2 },
    { actions: [cut(mid)], pause: 1.4 },
    { actions: [cut(deep)], pause: 1.4 },
    { narration: 'narr.spatula', tool: 'spatula', actions: [{ type: 'click', tool: 'spatula', target: NONE }], pause: 3 },
    { narration: 'narr.identify', actions: [identify({ kind: 'vessel', id: 'm1' })], pause: 1.4 },
    { actions: [identify(ICA)], pause: 1.2 },
    { actions: [identify({ kind: 'nerve', id: 'optic' })], pause: 1.2 },
    { actions: [identify({ kind: 'vessel', id: 'pcom' })], pause: 1.2 },
    { actions: [identify({ kind: 'vessel', id: 'achoa' })], pause: 1.2 },
    { narration: 'narr.cistern', tool: 'scissors', actions: [cut(cistern)], pause: 1.6 },
    { narration: 'narr.zoom', camera: 'neck', pause: 2 },
    { narration: 'narr.dissect', tool: 'dissector', actions: [dissect], pause: 1.6 },
    { actions: [dissect], pause: 1.4 },
    { actions: [dissect], pause: 1.6 },
    { narration: 'narr.bipolar', tool: 'bipolar', hold: { target: { kind: 'ooze', id: 'ooze-neck' }, seconds: RULES.coagulateSeconds + 0.4 }, pause: 1 },
    { narration: 'narr.temp', tool: 'tempClip', actions: [{ type: 'click', tool: 'tempClip', target: ICA }], pause: 2 },
    {
      narration: 'narr.clip',
      tool: 'clip',
      actions: [{ type: 'setClip', ...goodClip() }, { type: 'click', tool: 'clip', target: NECK }],
      pause: 2.4,
    },
    { narration: 'narr.release', tool: 'tempClip', actions: [{ type: 'click', tool: 'tempClip', target: ICA }], pause: 1.4 },
    { narration: 'narr.doppler', tool: 'doppler', hold: { target: { kind: 'aneurysm', part: 'dome' }, seconds: 1.6 }, pause: 0.5 },
    { hold: { target: { kind: 'vessel', id: 'pcom' }, seconds: 1.6 }, pause: 0.8 },
    { narration: 'narr.icg', tool: 'icg', actions: [{ type: 'click', tool: 'icg', target: NONE }], pause: 2.6 },
    { narration: 'narr.done', pause: 1.5 },
  ];
}

export interface DemoOutput {
  readonly narration: MessageKey | null;
  readonly tool: ToolId | null;
  readonly camera: CameraShot | null;
  readonly actions: readonly Action[];
  readonly finished: boolean;
}

/** Walks the plan as time passes. */
export class DemoRunner {
  private index = -1;
  private elapsed = 0;
  private holdLeft = 0;
  private tool: ToolId = 'scissors';

  constructor(private readonly plan: readonly DemoStep[] = demoPlan()) {}

  get done(): boolean {
    return this.index >= this.plan.length;
  }

  /** Move on by `dt` seconds and say what to do now. */
  step(dt: number): DemoOutput {
    if (this.done) return { narration: null, tool: null, camera: null, actions: [], finished: true };
    const actions: Action[] = [];
    let narration: MessageKey | null = null;
    let tool: ToolId | null = null;
    let camera: CameraShot | null = null;

    const current = (): DemoStep | undefined => this.plan[this.index];
    const enter = (): void => {
      const next = this.plan[this.index];
      if (!next) return;
      narration = next.narration ?? narration;
      camera = next.camera ?? camera;
      if (next.tool) {
        tool = next.tool;
        this.tool = next.tool;
      }
      actions.push(...(next.actions ?? []));
      this.holdLeft = next.hold?.seconds ?? 0;
      this.elapsed = 0;
    };

    if (this.index === -1) {
      this.index = 0;
      enter();
    }
    let budget = Math.max(0, dt);
    // Time may carry us through more than one step in a single call (a long frame, or a fast demo).
    for (let guard = 0; guard < 64 && !this.done; guard++) {
      const step = current();
      if (!step) break;
      const holdPart = Math.min(budget, this.holdLeft);
      if (holdPart > 0 && step.hold) {
        actions.push({ type: 'hold', tool: this.tool, target: step.hold.target, dt: holdPart });
        this.holdLeft -= holdPart;
        budget -= holdPart;
        this.elapsed += holdPart;
      }
      if (this.holdLeft > 1e-9) break;
      const total = (step.hold?.seconds ?? 0) + step.pause;
      const wait = Math.min(budget, Math.max(0, total - this.elapsed));
      this.elapsed += wait;
      budget -= wait;
      if (this.elapsed >= total - 1e-9) {
        this.index += 1;
        if (this.done) break;
        enter();
      } else {
        break;
      }
    }
    return { narration, tool, camera, actions, finished: this.done };
  }
}
