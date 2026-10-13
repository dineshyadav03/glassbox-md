/**
 * The demo autopilot: a scripted operator that performs the whole case through the same input path as a
 * learner. Each step it looks at the simulation and answers with what a person would be holding down
 * (`Controls`) and any one-off presses (`Action`s); nothing reaches into the state. Pure, so a whole demo
 * can be replayed and checked in a test, and the screen runs exactly the same function.
 *
 * It narrates each step through the mentor log. The plan (sizes and pressures) is a parameter so the
 * same script can also play a deliberately poor case.
 */
import { LESION } from '../config/anatomy';
import { NO_CONTROLS, act, tick, type Action, type Controls, type Simulation } from '../engine/simulation';

export interface DemoPlan {
  readonly balloon: { readonly diameter: number; readonly length: number; readonly atm: number; readonly holdS: number };
  readonly stent: { readonly diameter: number; readonly length: number; readonly atm: number };
}

/** The textbook case: a 2.5 x 15 balloon at 10 atm for about 12 s, then a 3.0 x 18 stent at 12 atm. */
export const GOOD_PLAN: DemoPlan = {
  balloon: { diameter: 2.5, length: 15, atm: 10, holdS: 12 },
  stent: { diameter: 3.0, length: 18, atm: 12 },
};

export type PilotStep =
  | 'turn-to-left-cusp'
  | 'guide-up-the-arm'
  | 'seat-the-guide'
  | 'first-angiogram'
  | 'heparin-and-measure'
  | 'turn-wire-to-lad'
  | 'wire-into-lad'
  | 'straighten-wire'
  | 'cross-the-lesion'
  | 'load-balloon'
  | 'advance-balloon'
  | 'inflate-balloon'
  | 'hold-balloon'
  | 'deflate-balloon'
  | 'withdraw-balloon'
  | 'load-stent'
  | 'advance-stent'
  | 'inflate-stent'
  | 'hold-stent'
  | 'deflate-stent'
  | 'withdraw-stent'
  | 'second-view-first-run'
  | 'change-projection'
  | 'second-view-second-run'
  | 'finished';

export interface PilotState {
  readonly plan: DemoPlan;
  readonly step: PilotStep;
  /** Seconds spent in the current step. */
  readonly elapsed: number;
  /** Which part of a contrast run the pilot is in: pedal down, waiting for the run to end. */
  readonly run: 'pedal' | 'wait';
  /** Narration already given, so each line is said once. */
  readonly said: readonly string[];
}

export function createPilot(plan: DemoPlan = GOOD_PLAN): PilotState {
  return { plan, step: 'turn-to-left-cusp', elapsed: 0, run: 'pedal', said: [] };
}

export interface PilotOutput {
  readonly state: PilotState;
  readonly controls: Controls;
  readonly actions: readonly Action[];
}

const NARRATION: Readonly<Record<PilotStep, string>> = {
  'turn-to-left-cusp': 'First I turn the guide\'s tip toward the left coronary cusp, so it will find the left main later.',
  'guide-up-the-arm': 'Now the guide goes up the right radial artery, with short taps of fluoroscopy to see where it is, never blind.',
  'seat-the-guide': 'At the aortic root I advance gently so the tip seats in the left main. A fast push would bounce off.',
  'first-angiogram': 'With the guide seated, a diagnostic angiogram: pedal down, then inject contrast.',
  'heparin-and-measure': 'Heparin before the wire goes in, and a measurement of the vessel so the stent is sized from numbers.',
  'turn-wire-to-lad': 'The wire tip is turned toward the LAD angle, so at the end of the left main it chooses the LAD, not the circumflex.',
  'wire-into-lad': 'Advancing slowly into the left main and out along the LAD.',
  'straighten-wire': 'Back to neutral, so the wire passes the diagonal branches instead of entering them.',
  'cross-the-lesion': 'Across the 90% blockage slowly, never forcing it, and parking the wire well beyond.',
  'load-balloon': 'A 2.5 x 15 mm balloon, sized to open the lesion without over-stretching the vessel.',
  'advance-balloon': 'The balloon runs over the wire until it is centred on the lesion.',
  'inflate-balloon': 'Inflating to 10 atm, under the rated burst pressure.',
  'hold-balloon': 'Holding for about 12 seconds to open the blockage. The patient is not getting blood past it, so I watch the monitor.',
  'deflate-balloon': 'Deflating now, and the patient recovers.',
  'withdraw-balloon': 'Balloon withdrawn into the guide, leaving the wire across the lesion.',
  'load-stent': 'A 3.0 x 18 mm stent: the vessel measured about 3 mm, and 18 mm covers the 14 mm lesion with margin at each end.',
  'advance-stent': 'Advancing the stent until it extends past both ends of the lesion.',
  'inflate-stent': 'Deploying at 12 atm.',
  'hold-stent': 'A moment at pressure so the stent is fully apposed.',
  'deflate-stent': 'Deflating the stent balloon. The stent stays.',
  'withdraw-stent': 'Delivery catheter out; the stent holds the artery open.',
  'second-view-first-run': 'The final angiogram: is the artery open, is flow brisk, is there a tear?',
  'change-projection': 'A second look from a different angle, so nothing hides behind overlapping vessels.',
  'second-view-second-run': 'The second projection.',
  finished: 'All six steps are done. Reviewing the debrief.',
};

const done = (state: PilotState, next: PilotStep): PilotState => ({ ...state, step: next, elapsed: 0, run: 'pedal' });

/** Narrate a step once, when first reached. */
function narrate(state: PilotState, id: string, text: string): { state: PilotState; actions: Action[] } {
  if (state.said.includes(id)) return { state, actions: [] };
  return { state: { ...state, said: [...state.said, id] }, actions: [{ type: 'narrate', text }] };
}

const hold = (partial: Partial<Controls>): Controls => ({ ...NO_CONTROLS, ...partial });

/**
 * One decision of the autopilot. `dt` is the time that is about to pass (seconds). Returns the new
 * pilot state, what to hold during that time, and any buttons to press first.
 */
export function pilotStep(pilot: PilotState, sim: Simulation, dt: number): PilotOutput {
  if (sim.ended || pilot.step === 'finished') return { state: pilot, controls: NO_CONTROLS, actions: [] };

  let state: PilotState = { ...pilot, elapsed: pilot.elapsed + dt };
  const said = narrate(state, state.step, NARRATION[state.step]);
  state = said.state;
  const actions: Action[] = [...said.actions];
  const plan = state.plan;

  /** A contrast run, as a person does it: pedal down, press inject, keep the pedal until the run is over. */
  const contrastRun = (next: PilotStep): Controls => {
    if (state.run === 'pedal') {
      if (sim.fluoroOn) {
        actions.push({ type: 'inject' });
        state = { ...state, run: 'wait' };
      }
      return hold({ fluoro: true });
    }
    if (sim.injection === null) {
      state = done(state, next);
      return NO_CONTROLS;
    }
    return hold({ fluoro: true });
  };

  switch (state.step) {
    case 'turn-to-left-cusp': {
      if (sim.guide.rotationDeg >= 58) {
        state = done(state, 'guide-up-the-arm');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ rotate: 1 }), actions };
    }

    case 'guide-up-the-arm': {
      const s = sim.guide.s;
      if (s >= 829.5) {
        state = done(state, 'seat-the-guide');
        return { state, controls: NO_CONTROLS, actions };
      }
      // Short taps of fluoroscopy at the elbow and the shoulder.
      const tap = (s >= 270 && s <= 350) || (s >= 580 && s <= 650);
      return { state, controls: hold({ advance: 1, fluoro: tap }), actions };
    }

    case 'seat-the-guide': {
      if (sim.guide.engaged) {
        state = done(state, 'first-angiogram');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: 1, fine: true }), actions };
    }

    case 'first-angiogram': {
      const controls = contrastRun('heparin-and-measure');
      return { state, controls, actions };
    }

    case 'heparin-and-measure': {
      actions.push({ type: 'heparin' }, { type: 'measure' }, { type: 'select-tool', tool: 'wire' });
      state = done(state, 'turn-wire-to-lad');
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'turn-wire-to-lad': {
      if (sim.wire.rotationDeg <= -42) {
        state = done(state, 'wire-into-lad');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ rotate: -1 }), actions };
    }

    case 'wire-into-lad': {
      if (sim.wire.vessel === 'LAD') {
        state = done(state, 'straighten-wire');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: 1, fine: true }), actions };
    }

    case 'straighten-wire': {
      if (sim.wire.rotationDeg >= -8) {
        state = done(state, 'cross-the-lesion');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ rotate: 1 }), actions };
    }

    case 'cross-the-lesion': {
      if (sim.wire.s >= 78) {
        state = done(state, 'load-balloon');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: 1, fine: true }), actions };
    }

    case 'load-balloon': {
      actions.push(
        { type: 'select-tool', tool: 'balloon' },
        { type: 'choose-size', kind: 'balloon', diameter: plan.balloon.diameter, length: plan.balloon.length },
      );
      state = done(state, 'advance-balloon');
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'advance-balloon': {
      const centre = sim.balloon.centreS ?? 0;
      if (!sim.balloon.inGuide && centre >= LESION.centreS - 0.6) {
        state = done(state, 'inflate-balloon');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: 1, fine: centre >= LESION.centreS - 6 }), actions };
    }

    case 'inflate-balloon': {
      if (sim.balloon.pressure >= plan.balloon.atm) {
        state = done(state, 'hold-balloon');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ inflate: true }), actions };
    }

    case 'hold-balloon': {
      if (state.elapsed >= plan.balloon.holdS) {
        state = done(state, 'deflate-balloon');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'deflate-balloon': {
      if (sim.balloon.pressure < 1) {
        state = done(state, 'withdraw-balloon');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ deflate: true }), actions };
    }

    case 'withdraw-balloon': {
      if (sim.balloon.inGuide) {
        state = done(state, 'load-stent');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: -1 }), actions };
    }

    case 'load-stent': {
      actions.push(
        { type: 'select-tool', tool: 'stent' },
        { type: 'choose-size', kind: 'stent', diameter: plan.stent.diameter, length: plan.stent.length },
      );
      state = done(state, 'advance-stent');
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'advance-stent': {
      const centre = sim.stent.centreS ?? 0;
      if (!sim.stent.inGuide && centre >= LESION.centreS - 0.4) {
        state = done(state, 'inflate-stent');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: 1, fine: centre >= LESION.centreS - 5 }), actions };
    }

    case 'inflate-stent': {
      if (sim.stent.pressure >= plan.stent.atm) {
        state = done(state, 'hold-stent');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ inflate: true }), actions };
    }

    case 'hold-stent': {
      if (state.elapsed >= 2) {
        state = done(state, 'deflate-stent');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'deflate-stent': {
      if (sim.stent.pressure < 1) {
        state = done(state, 'withdraw-stent');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ deflate: true }), actions };
    }

    case 'withdraw-stent': {
      if (sim.stent.inGuide) {
        actions.push({ type: 'select-tool', tool: 'guide' });
        state = done(state, 'second-view-first-run');
        return { state, controls: NO_CONTROLS, actions };
      }
      return { state, controls: hold({ advance: -1 }), actions };
    }

    case 'second-view-first-run': {
      const controls = contrastRun('change-projection');
      return { state, controls, actions };
    }

    case 'change-projection': {
      actions.push({ type: 'cycle-carm', direction: 1 });
      state = done(state, 'second-view-second-run');
      return { state, controls: NO_CONTROLS, actions };
    }

    case 'second-view-second-run': {
      const controls = contrastRun('finished');
      return { state, controls, actions };
    }

    case 'finished':
      return { state, controls: NO_CONTROLS, actions };
  }
}

/**
 * Run the autopilot for `dt` seconds of case time, in small steps, using the real engine. Used by the
 * screen and by the tests alike. Returns the new case and pilot.
 */
export function advanceDemo(
  sim: Simulation,
  pilot: PilotState,
  dt: number,
  rng: () => number = () => 0.99,
  maxStep = 0.05,
): { sim: Simulation; pilot: PilotState } {
  const pieces = Math.max(1, Math.ceil(dt / maxStep));
  const piece = dt / pieces;
  let s = sim;
  let p = pilot;
  for (let i = 0; i < pieces; i++) {
    if (s.ended) break;
    const out = pilotStep(p, s, piece);
    p = out.state;
    for (const action of out.actions) s = act(s, action);
    s = tick(s, out.controls, piece, rng);
  }
  return { sim: s, pilot: p };
}

/** Whether the pilot has nothing more to do. */
export function pilotFinished(pilot: PilotState, sim: Simulation): boolean {
  return pilot.step === 'finished' || sim.ended;
}
