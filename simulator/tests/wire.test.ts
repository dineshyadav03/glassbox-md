import { describe, expect, it } from 'vitest';
import { LESION, LESION_END, LESION_START, VESSELS, WIRE, pathOffsetOf, childrenOf } from '../src/config/anatomy';
import {
  chooseBranch,
  createWire,
  describeWireEvent,
  safeSpeed,
  stepWire,
  upcomingBranch,
  wireBeyondLesion,
  wireParkedDistally,
  wirePathS,
  type WireContext,
  type WireEvent,
  type WireInput,
  type WireState,
} from '../src/physics/wire';

const ENGAGED: WireContext = { guideEngaged: true, balloonOnWire: false };
const NEVER = () => 0.9999;
const ALWAYS = () => 0;

function run(
  start: WireState,
  input: WireInput,
  seconds: number,
  context: WireContext = ENGAGED,
  rng: () => number = NEVER,
  dt = 0.02,
): { state: WireState; events: WireEvent[] } {
  let state = start;
  const events: WireEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const out = stepWire(state, input, context, dt, rng);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

const push = (speed: number, rotate = 0): WireInput => ({ advanceSpeed: speed, rotateRate: rotate });
const at = (vessel: WireState['vessel'], s: number, rotationDeg = 0): WireState => ({
  ...createWire(),
  outOfGuide: true,
  vessel,
  s,
  rotationDeg,
});

describe('leaving the guide', () => {
  it('will not leave until the guide is engaged, and says so', () => {
    const out = run(createWire(), push(25), 1, { guideEngaged: false, balloonOnWire: false });
    expect(out.state.outOfGuide).toBe(false);
    expect(out.events.some((e) => e.type === 'needs-engaged-guide')).toBe(true);
    expect(describeWireEvent({ type: 'needs-engaged-guide' })).toMatch(/Engage the guide/);
  });

  it('exits into the left main and advances', () => {
    const out = run(createWire(), push(10), 0.5);
    expect(out.state.vessel).toBe('LM');
    expect(out.state.s).toBeCloseTo(5, 1);
    expect(out.events[0]).toEqual({ type: 'entered', vessel: 'LM' });
  });

  it('rotates even when not moving', () => {
    expect(run(createWire(), push(0, 90), 1).state.rotationDeg).toBeCloseTo(90);
  });
});

describe('choosing a branch', () => {
  const lm = childrenOf('LM');
  const lad = childrenOf('LAD');
  const d1 = lad.filter((c) => c.id === 'D1');
  const d2 = lad.filter((c) => c.id === 'D2');

  it('picks the nearer of LAD (-45) and LCx (+20) where the left main ends, whatever the distance', () => {
    expect(chooseBranch(lm, false, 0)?.id).toBe('LCx'); // neutral goes to the circumflex
    expect(chooseBranch(lm, false, -40)?.id).toBe('LAD');
    expect(chooseBranch(lm, false, 90)?.id).toBe('LCx');
    expect(chooseBranch(lm, false, -150)?.id).toBe('LAD');
    expect(chooseBranch(lm, false, -13)?.id).toBe('LAD');
    expect(chooseBranch(lm, false, -12)?.id).toBe('LCx');
  });

  it('sends a tie to the branch listed first', () => {
    expect(chooseBranch(lm, false, -12.5)?.id).toBe('LAD');
  });

  it('captures a diagonal only within 50 degrees of its angle, where the LAD carries on', () => {
    expect(chooseBranch(d1, true, 20)?.id).toBe('D1');
    expect(chooseBranch(d1, true, 19.9)).toBeNull();
    expect(chooseBranch(d1, true, 0)).toBeNull();
    expect(chooseBranch(d2, true, -20)?.id).toBe('D2');
    expect(chooseBranch(d2, true, -19.9)).toBeNull();
    expect(chooseBranch(d2, true, 0)).toBeNull();
  });

  it('enters the LAD from the left main when the tip is turned toward it', () => {
    const turned = at('LM', 0, -40);
    const out = run(turned, push(25), 1);
    expect(out.state.vessel).toBe('LAD');
    expect(out.events).toContainEqual({ type: 'entered', vessel: 'LAD' });
  });

  it('enters the circumflex from the left main at neutral', () => {
    expect(run(at('LM', 0, 0), push(25), 1).state.vessel).toBe('LCx');
  });

  it('carries straight down the LAD past both diagonals with a neutral tip', () => {
    const out = run(at('LAD', 20, 0), push(25), 4);
    expect(out.state.vessel).toBe('LAD');
    expect(out.state.s).toBeGreaterThan(VESSELS.D2.branchS);
    expect(out.events.some((e) => e.type === 'entered')).toBe(false);
  });

  it('goes into D1 when the tip is turned toward it as it passes', () => {
    expect(run(at('LAD', 25, 60), push(25), 1).state.vessel).toBe('D1');
  });

  it('goes into D2 when the tip is turned toward it as it passes', () => {
    expect(run(at('LAD', 65, -60), push(25), 1).state.vessel).toBe('D2');
  });

  it('decides with the rotation at the moment it passes the branch, not before', () => {
    // Turned toward D1 at first, then neutral by the time it reaches the branch point.
    let state = at('LAD', 10, 60);
    state = run(state, push(0, -60), 1).state; // rotate to 0
    expect(run(state, push(25), 2).state.vessel).toBe('LAD');
  });
});

describe('retracting', () => {
  it('pulls back along the same path, through the parent', () => {
    const inLad = at('LAD', 3, 0);
    const out = run(inLad, push(-25), 0.4); // 10 mm back: out of the LAD into the left main
    expect(out.state.vessel).toBe('LM');
    expect(out.state.s).toBeCloseTo(VESSELS.LAD.branchS - 7, 1);
  });

  it('goes back into the guide when fully withdrawn', () => {
    const out = run(at('LM', 4), push(-25), 1);
    expect(out.state.outOfGuide).toBe(false);
    expect(out.state.vessel).toBeNull();
    expect(out.events).toContainEqual({ type: 'back-in-guide' });
  });

  it('cannot be pulled back while a balloon is on it', () => {
    const out = run(at('LAD', 60), push(-25), 1, { guideEngaged: true, balloonOnWire: true });
    expect(out.state.s).toBe(60);
    expect(out.events.some((e) => e.type === 'held-by-balloon')).toBe(true);
  });

  it('may still be advanced and rotated with a balloon on it', () => {
    const out = run(at('LAD', 60), push(10, 30), 1, { guideEngaged: true, balloonOnWire: true });
    expect(out.state.s).toBeGreaterThan(60);
  });
});

describe('forcing the lesion', () => {
  const justBefore = () => at('LAD', LESION_START - 1);

  it('computes the safe speed: 8 mm/s, rising to 16 with full spin', () => {
    expect(safeSpeed(0)).toBe(WIRE.safeSpeed);
    expect(safeSpeed(WIRE.spinReferenceRate)).toBe(2 * WIRE.safeSpeed);
    expect(safeSpeed(-WIRE.spinReferenceRate)).toBe(2 * WIRE.safeSpeed);
    expect(safeSpeed(WIRE.spinReferenceRate / 2)).toBeCloseTo(1.5 * WIRE.safeSpeed);
    expect(safeSpeed(1000)).toBe(2 * WIRE.safeSpeed);
  });

  it('adds no risk, no buckling, and a modest resistance when advanced gently', () => {
    const out = run(justBefore(), push(6), 2.5);
    expect(out.state.dissectionRisk).toBe(0);
    expect(out.state.buckled).toBe(false);
    expect(out.state.forcingSeconds).toBe(0);
    expect(out.events.some((e) => e.type === 'buckling')).toBe(false);
  });

  it('shows the resistance meter rising with push inside the lesion', () => {
    const slow = run(justBefore(), push(4), 0.5).state.resistance;
    const fast = run(justBefore(), push(12), 0.5).state.resistance;
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(1);
  });

  it('buckles and builds hidden risk when pushed faster than the safe speed, announced once', () => {
    const out = run(justBefore(), push(20), 0.5);
    expect(out.state.buckled).toBe(true);
    expect(out.state.dissectionRisk).toBeGreaterThan(0);
    expect(out.state.forcingSeconds).toBeGreaterThan(0.4);
    expect(out.events.filter((e) => e.type === 'buckling')).toHaveLength(1);
    expect(describeWireEvent({ type: 'buckling' })).toMatch(/buckling/);
  });

  it('builds more risk the harder it is forced, capped below certainty', () => {
    const firm = run(justBefore(), push(12), 1).state.dissectionRisk;
    const hard = run(justBefore(), push(40), 1).state.dissectionRisk;
    expect(hard).toBeGreaterThan(firm);
    expect(run(at('LAD', LESION_START - 1), push(60), 3).state.dissectionRisk).toBeLessThanOrEqual(WIRE.maxRisk);
  });

  it('lets spinning the wire raise the safe speed: 12 mm/s forces without spin but not with it', () => {
    const noSpin = run(justBefore(), push(12, 0), 0.5).state;
    const spinning = run(justBefore(), push(12, WIRE.spinReferenceRate), 0.5).state;
    expect(noSpin.buckled).toBe(true);
    expect(spinning.buckled).toBe(false);
    expect(spinning.dissectionRisk).toBe(0);
  });

  it('adds no risk outside the lesion however fast it is pushed', () => {
    const out = run(at('LAD', 5), push(60), 0.5);
    expect(out.state.dissectionRisk).toBe(0);
    expect(out.state.resistance).toBe(0);
    expect(out.state.buckled).toBe(false);
  });
});

describe('crossing the lesion', () => {
  /** Cross from just before to just beyond at a given speed, with a given random draw. */
  function cross(speed: number, rng: () => number, rotate = 0) {
    return run(at('LAD', LESION_START - 1), push(speed, rotate), (LESION.length + 4) / speed, ENGAGED, rng);
  }

  it('crosses gently with no dissection, whatever the draw', () => {
    const out = cross(6, ALWAYS);
    expect(out.state.dissected).toBe(false);
    expect(out.events).toContainEqual({ type: 'crossed' });
    expect(wireBeyondLesion(out.state)).toBe(true);
  });

  it('may cause a dissection when forced, if the roll falls inside the risk, announced once', () => {
    const out = cross(30, ALWAYS);
    expect(out.state.dissected).toBe(true);
    expect(out.events.filter((e) => e.type === 'dissection')).toEqual([{ type: 'dissection', s: LESION.centreS }]);
    expect(describeWireEvent({ type: 'dissection', s: 48 })).toMatch(/dissection/);
  });

  it('may cross unharmed when forced, if the roll falls outside the risk', () => {
    const out = cross(30, NEVER);
    expect(out.state.dissectionRisk).toBeGreaterThan(0);
    expect(out.state.dissected).toBe(false);
  });

  it('rolls exactly once per crossing', () => {
    let draws = 0;
    cross(30, () => {
      draws += 1;
      return 0.9999;
    });
    expect(draws).toBe(1);
  });

  it('does not roll at all for a gentle crossing (zero risk can never hit)', () => {
    expect(cross(6, ALWAYS).state.dissected).toBe(false);
  });

  it('does not roll a second dissection once one has occurred', () => {
    const first = cross(30, ALWAYS).state;
    const pulledBack = run(first, push(-25), 2).state;
    expect(pulledBack.dissected).toBe(true);
    const again = run(pulledBack, push(25), 3, ENGAGED, ALWAYS);
    expect(again.events.filter((e) => e.type === 'dissection')).toHaveLength(0);
  });

  it('counts as a new attempt, with a new roll, after being pulled back proximal to the lesion', () => {
    const first = run(at('LAD', LESION_START - 1), push(30), 1, ENGAGED, NEVER).state;
    expect(first.crossingResolved).toBe(true);
    const back = run(first, push(-30), 2).state;
    expect(back.crossingResolved).toBe(false);
  });

  it('reports being beyond the lesion and parked distally', () => {
    expect(wireBeyondLesion(at('LAD', LESION_END + 1))).toBe(true);
    expect(wireBeyondLesion(at('LAD', LESION_END - 1))).toBe(false);
    expect(wireBeyondLesion(at('D2', 5))).toBe(true);
    expect(wireBeyondLesion(at('D1', 5))).toBe(false);
    expect(wireBeyondLesion(createWire())).toBe(false);
    expect(wireParkedDistally(at('LAD', LESION_END + WIRE.parkMarginMm))).toBe(true);
    expect(wireParkedDistally(at('LAD', LESION_END + WIRE.parkMarginMm - 1))).toBe(false);
    expect(wireParkedDistally(at('LCx', 60))).toBe(false);
  });
});

describe('the end of a vessel', () => {
  it('warns once near the distal end, then stops at it', () => {
    const out = run(at('LAD', 100), push(10), 3);
    expect(out.state.s).toBe(VESSELS.LAD.length);
    expect(out.events.filter((e) => e.type === 'near-vessel-end')).toHaveLength(1);
    expect(out.events.some((e) => e.type === 'vessel-end')).toBe(true);
    expect(describeWireEvent({ type: 'near-vessel-end' })).toMatch(/perforation/);
  });

  it('does not warn well away from the end', () => {
    expect(run(at('LAD', 80), push(10), 1).events.some((e) => e.type === 'near-vessel-end')).toBe(false);
  });

  it('can warn again on a second approach after pulling back', () => {
    const first = run(at('LAD', 100), push(10), 1).state;
    const back = run(first, push(-20), 2).state; // 40 mm back, to s = 70
    expect(back.warnedEnd).toBe(false);
    expect(run(back, push(10), 4).events.filter((e) => e.type === 'near-vessel-end')).toHaveLength(1);
  });
});

describe('hints and positions', () => {
  it('shows the next bifurcation ahead, with the angle each branch needs', () => {
    const hint = upcomingBranch(at('LAD', 20))!;
    expect(hint.distanceMm).toBeCloseTo(10);
    expect(hint.parentContinues).toBe(true);
    expect(hint.options).toEqual([{ vessel: 'D1', label: 'First diagonal', angleDeg: 70 }]);
  });

  it('shows both branches at the end of the left main', () => {
    const hint = upcomingBranch(at('LM', 5))!;
    expect(hint.parentContinues).toBe(false);
    expect(hint.options.map((o) => o.vessel)).toEqual(['LAD', 'LCx']);
  });

  it('shows nothing when none is near, none is ahead, or the wire is in the guide', () => {
    expect(upcomingBranch(at('LAD', 5), 10)).toBeNull();
    expect(upcomingBranch(at('LAD', 90))).toBeNull();
    expect(upcomingBranch(createWire())).toBeNull();
  });

  it('gives the tip position along the single rail', () => {
    expect(wirePathS(createWire())).toBeNull();
    expect(wirePathS(at('LM', 4))).toBe(4);
    expect(wirePathS(at('LAD', 10))).toBe(pathOffsetOf('LAD') + 10);
    expect(wirePathS(at('D2', 3))).toBe(pathOffsetOf('D2') + 3);
  });

  it('describes every event', () => {
    const events: WireEvent[] = [
      { type: 'needs-engaged-guide' }, { type: 'held-by-balloon' }, { type: 'entered', vessel: 'LAD' },
      { type: 'back-in-guide' }, { type: 'buckling' }, { type: 'crossed' }, { type: 'dissection', s: 48 },
      { type: 'near-vessel-end' }, { type: 'vessel-end' },
    ];
    for (const event of events) expect(describeWireEvent(event).length).toBeGreaterThan(10);
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const frozen = Object.freeze(at('LAD', LESION_START - 1));
    expect(() => stepWire(frozen, push(30), ENGAGED, 0.1, NEVER)).not.toThrow();
    expect(frozen.dissectionRisk).toBe(0);
  });
});
