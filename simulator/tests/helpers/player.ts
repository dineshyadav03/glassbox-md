/**
 * A scripted "learner" for engine tests: holds keys for simulated seconds and presses buttons, exactly as
 * a person would, with no shortcuts into the state. `playGoodCase` is the careful run through all six
 * stages; options let a test make one specific mistake and nothing else.
 */
import {
  NO_CONTROLS,
  act,
  createSimulation,
  factsOf,
  tick,
  type Action,
  type Controls,
  type Simulation,
} from '../../src/engine/simulation';

export const DT = 0.05;

export class Player {
  sim: Simulation;
  constructor(private readonly rng: () => number = () => 0.99, sim: Simulation = createSimulation()) {
    this.sim = sim;
  }

  hold(controls: Partial<Controls>, seconds: number): this {
    const c = { ...NO_CONTROLS, ...controls };
    for (let t = 0; t < seconds - 1e-9; t += DT) this.sim = tick(this.sim, c, DT, this.rng);
    return this;
  }

  /** Hold until the condition is true; fails loudly if it never is. */
  until(controls: Partial<Controls>, done: (sim: Simulation) => boolean, maxSeconds = 120): this {
    const c = { ...NO_CONTROLS, ...controls };
    let t = 0;
    while (!done(this.sim)) {
      if (t > maxSeconds) throw new Error(`condition not reached in ${maxSeconds} s (sim time ${this.sim.time.toFixed(1)})`);
      this.sim = tick(this.sim, c, DT, this.rng);
      t += DT;
    }
    return this;
  }

  wait(seconds: number): this {
    return this.hold({}, seconds);
  }

  do(action: Action): this {
    this.sim = act(this.sim, action);
    return this;
  }

  facts() {
    return factsOf(this.sim);
  }

  lastMessage(): string {
    return this.sim.messages[this.sim.messages.length - 1]?.text ?? '';
  }

  /** Inject contrast as a person does: foot on the pedal, press the button, wait for the run to finish. */
  angiogram(): this {
    this.hold({ fluoro: true }, 0.1).do({ type: 'inject' }).hold({ fluoro: true }, 1.5);
    // The last injection of the case ends the case, which freezes the clock, so stop waiting then too.
    return this.until({}, (s) => s.injection === null || s.ended);
  }
}

export interface CaseOptions {
  /** Skip the heparin. */
  noHeparin?: boolean;
  /** Push the wire through the lesion at full speed instead of slowly. */
  forceWire?: boolean;
  balloon?: { diameter: number; length: number; atm: number; holdS: number };
  stent?: { diameter: number; length: number; atm: number };
  /** Take only one final projection. */
  oneFinalView?: boolean;
  /** Skip pre-dilation and stop after the wire (for tests of the stage lock). */
  stopAfterWire?: boolean;
}

/** The careful run: every step in order, gently, ending with the final angiogram from two projections. */
export function playGoodCase(options: CaseOptions = {}, rng: () => number = () => 0.99): Player {
  const p = new Player(rng);
  const balloon = options.balloon ?? { diameter: 2.5, length: 15, atm: 10, holdS: 8 };
  const stent = options.stent ?? { diameter: 3.0, length: 18, atm: 12 };

  // 1. The guide to the aortic root, a short look on fluoroscopy once past the elbow.
  p.hold({ rotate: 1 }, 1);
  p.until({ advance: 1 }, (s) => s.guide.s >= 300);
  p.hold({ advance: 1, fluoro: true }, 1);
  p.until({ advance: 1 }, (s) => s.guide.s >= 829.9);

  // 2. Seat it, then a diagnostic angiogram.
  p.until({ advance: 1, fine: true }, (s) => s.guide.engaged, 20);
  p.angiogram();

  // 3. Heparin, measure, then the wire: into the LAD, back to neutral, slowly across and parked.
  if (!options.noHeparin) p.do({ type: 'heparin' });
  p.do({ type: 'measure' });
  p.do({ type: 'select-tool', tool: 'wire' });
  p.hold({ rotate: -1 }, 0.5);
  p.until({ advance: 1, fine: true }, (s) => s.wire.vessel === 'LAD', 30);
  p.hold({ rotate: 1 }, 0.5);
  if (options.forceWire) {
    p.until({ advance: 1 }, (s) => s.wire.s >= 78, 30);
  } else {
    p.until({ advance: 1, fine: true }, (s) => s.wire.s >= 78, 60);
  }
  if (options.stopAfterWire) return p;

  // 4. Pre-dilate.
  p.do({ type: 'select-tool', tool: 'balloon' });
  p.do({ type: 'choose-size', kind: 'balloon', diameter: balloon.diameter, length: balloon.length });
  p.until({ advance: 1 }, (s) => factsOf(s).balloonAcrossLesion, 30);
  p.until({ inflate: true }, (s) => s.balloon.pressure >= balloon.atm, 30);
  p.wait(balloon.holdS);
  p.until({ deflate: true }, (s) => s.balloon.pressure < 1, 30);
  p.until({ advance: -1 }, (s) => s.balloon.inGuide, 60);

  // 5. Stent: size from the measurement, cover the lesion, deploy, deflate, withdraw the delivery catheter.
  p.do({ type: 'select-tool', tool: 'stent' });
  p.do({ type: 'choose-size', kind: 'stent', diameter: stent.diameter, length: stent.length });
  p.until({ advance: 1 }, (s) => (s.stent.centreS ?? 0) >= 44, 30);
  p.until({ advance: 1, fine: true }, (s) => (s.stent.centreS ?? 0) >= 47.6, 30);
  p.until({ inflate: true }, (s) => s.stent.pressure >= stent.atm, 30);
  p.wait(2);
  p.until({ deflate: true }, (s) => s.stent.pressure < 1, 30);
  p.until({ advance: -1 }, (s) => s.stent.inGuide, 60);

  // 6. Final angiogram, from two projections.
  p.do({ type: 'select-tool', tool: 'guide' });
  p.angiogram();
  if (!options.oneFinalView) {
    p.do({ type: 'cycle-carm', direction: 1 });
    p.angiogram();
  }
  return p;
}
