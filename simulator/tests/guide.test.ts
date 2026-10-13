import { describe, expect, it } from 'vitest';
import { AORTA_ENTRY_S, AORTIC_ROOT_S, ELBOW_S, GUIDE } from '../src/config/anatomy';
import { angleDiffDeg, normalizeDeg } from '../src/physics/angles';
import {
  createGuide,
  describeGuideEvent,
  facesLeftCusp,
  guideCheckpoints,
  otherCuspFacing,
  stepGuide,
  type GuideEvent,
  type GuideInput,
  type GuideState,
} from '../src/physics/guide';

const FREE = { wireOut: false };
const LEFT = GUIDE.leftCuspAngleDeg;
const RIGHT = GUIDE.rightCuspAngleDeg;

function run(
  start: GuideState,
  input: GuideInput,
  seconds: number,
  context = FREE,
  dt = 0.05,
): { state: GuideState; events: GuideEvent[] } {
  let state = start;
  const events: GuideEvent[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const out = stepGuide(state, input, context, dt);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

const atRoot = (rotationDeg: number): GuideState => ({ s: AORTIC_ROOT_S, rotationDeg, engaged: false, seatProgress: 0 });
const GENTLE: GuideInput = { advanceSpeed: GUIDE.fineAdvanceSpeed, rotateRate: 0 };
const spin = (rate: number): GuideInput => ({ advanceSpeed: 0, rotateRate: rate });

describe('angles', () => {
  it('wraps into (-180, 180]', () => {
    expect(normalizeDeg(190)).toBe(-170);
    expect(normalizeDeg(-190)).toBe(170);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(180)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(725)).toBe(5);
  });

  it('takes the short way round', () => {
    expect(angleDiffDeg(170, -170)).toBe(20);
    expect(angleDiffDeg(-170, 170)).toBe(20);
    expect(angleDiffDeg(10, 10)).toBe(0);
    expect(angleDiffDeg(0, 180)).toBe(180);
  });
});

describe('moving along the access route', () => {
  it('starts at the wrist, neutral, not engaged', () => {
    expect(createGuide()).toEqual({ s: 0, rotationDeg: 0, engaged: false, seatProgress: 0 });
  });

  it('advances at the commanded speed and stops at the aortic root', () => {
    const early = run(createGuide(), { advanceSpeed: 80, rotateRate: 0 }, 2);
    expect(early.state.s).toBeCloseTo(160, 6);
    const done = run(createGuide(), { advanceSpeed: 80, rotateRate: 0 }, 20);
    expect(done.state.s).toBe(AORTIC_ROOT_S);
    expect(done.state.engaged).toBe(false);
  });

  it('retracts, but not past the wrist', () => {
    expect(run({ ...createGuide(), s: 100 }, { advanceSpeed: -50, rotateRate: 0 }, 1).state.s).toBeCloseTo(50);
    expect(run({ ...createGuide(), s: 100 }, { advanceSpeed: -50, rotateRate: 0 }, 10).state.s).toBe(0);
  });

  it('reports the checkpoints on the way', () => {
    expect(guideCheckpoints(0)).toEqual({ pastElbow: false, inAorta: false, atRoot: false });
    expect(guideCheckpoints(ELBOW_S + 5).pastElbow).toBe(false);
    expect(guideCheckpoints(ELBOW_S + 10).pastElbow).toBe(true);
    expect(guideCheckpoints(AORTA_ENTRY_S - 1).inAorta).toBe(false);
    expect(guideCheckpoints(AORTA_ENTRY_S).inAorta).toBe(true);
    expect(guideCheckpoints(AORTIC_ROOT_S - 1).atRoot).toBe(false);
    expect(guideCheckpoints(AORTIC_ROOT_S).atRoot).toBe(true);
  });

  it('rotates, wrapping at 180 degrees', () => {
    expect(run(createGuide(), spin(60), 1).state.rotationDeg).toBeCloseTo(60);
    expect(run(createGuide(), spin(60), 4).state.rotationDeg).toBeCloseTo(normalizeDeg(240));
    expect(run(createGuide(), spin(-60), 1).state.rotationDeg).toBeCloseTo(-60);
  });

  it('cannot move while the wire is out, and says so, but can still rotate', () => {
    const blocked = run({ ...createGuide(), s: 400 }, { advanceSpeed: 80, rotateRate: 30 }, 1, { wireOut: true });
    expect(blocked.state.s).toBe(400);
    expect(blocked.events.some((e) => e.type === 'locked-by-wire')).toBe(true);
    expect(blocked.state.rotationDeg).toBeCloseTo(30);
    expect(describeGuideEvent({ type: 'locked-by-wire' })).toMatch(/wire/);
  });
});

describe('engaging the left main', () => {
  it('seats on a gentle advance with the tip facing the left cusp, announced once', () => {
    const { state, events } = run(atRoot(LEFT), GENTLE, 1);
    expect(state.engaged).toBe(true);
    expect(events.filter((e) => e.type === 'engaged')).toHaveLength(1);
    expect(state.s).toBe(AORTIC_ROOT_S);
  });

  it('needs the gentle advance to add up to the seating distance', () => {
    const brief = run(atRoot(LEFT), GENTLE, 0.25); // 3 mm
    expect(brief.state.engaged).toBe(false);
    expect(brief.state.seatProgress).toBeCloseTo(3, 6);
    expect(run(brief.state, GENTLE, 0.2).state.engaged).toBe(true);
  });

  it('accepts a tip within 25 degrees of the left cusp, not beyond', () => {
    expect(facesLeftCusp(LEFT + 25)).toBe(true);
    expect(facesLeftCusp(LEFT - 25)).toBe(true);
    expect(facesLeftCusp(LEFT + 26)).toBe(false);
    expect(run(atRoot(LEFT + 24), GENTLE, 1).state.engaged).toBe(true);
    expect(run(atRoot(LEFT + 30), GENTLE, 1).state.engaged).toBe(false);
  });

  it('gives a specific message when facing the right cusp', () => {
    const { state, events } = run(atRoot(RIGHT), GENTLE, 0.5);
    expect(state.engaged).toBe(false);
    const wrong = events.find((e) => e.type === 'wrong-cusp');
    expect(wrong).toEqual({ type: 'wrong-cusp', cusp: 'right' });
    expect(describeGuideEvent(wrong!)).toMatch(/right coronary cusp/);
  });

  it('distinguishes the non-coronary cusp and a tip facing nothing in particular', () => {
    expect(otherCuspFacing(180)).toBe('non-coronary');
    expect(otherCuspFacing(-180)).toBe('non-coronary');
    expect(otherCuspFacing(0)).toBe('none');
    expect(otherCuspFacing(RIGHT)).toBe('right');
    expect(describeGuideEvent({ type: 'wrong-cusp', cusp: 'non-coronary' })).toMatch(/non-coronary/);
    expect(describeGuideEvent({ type: 'wrong-cusp', cusp: 'none' })).toMatch(/not facing/);
  });

  it('bounces rather than seats if pushed fast', () => {
    const { state, events } = run(atRoot(LEFT), { advanceSpeed: 40, rotateRate: 0 }, 1);
    expect(state.engaged).toBe(false);
    expect(events.some((e) => e.type === 'too-fast')).toBe(true);
  });

  it('loses the seating progress if the tip turns away or it is pushed too fast part way', () => {
    const partial = run(atRoot(LEFT), GENTLE, 0.25).state;
    expect(partial.seatProgress).toBeGreaterThan(0);
    expect(run(partial, { advanceSpeed: 40, rotateRate: 0 }, 0.1).state.seatProgress).toBe(0);
    expect(run({ ...partial, rotationDeg: 0 }, GENTLE, 0.1).state.seatProgress).toBe(0);
  });

  it('does not seat anywhere but the root', () => {
    const { state } = run({ ...createGuide(), s: 600, rotationDeg: LEFT }, GENTLE, 5);
    expect(state.engaged).toBe(false);
    expect(state.s).toBeCloseTo(600 + GENTLE.advanceSpeed * 5);
  });
});

describe('once engaged', () => {
  const seated = (): GuideState => run(atRoot(LEFT), GENTLE, 1).state;

  it('stays seated through moderate rotation', () => {
    const turned = run(seated(), spin(10), 3.5); // 35 degrees from the left cusp
    expect(angleDiffDeg(turned.state.rotationDeg, LEFT)).toBeCloseTo(35, 4);
    expect(turned.state.engaged).toBe(true);
    expect(turned.events).toEqual([]);
  });

  it('pops out when twisted more than 40 degrees from the left cusp', () => {
    const turned = run(seated(), spin(10), 4.5); // 45 degrees
    expect(turned.state.engaged).toBe(false);
    expect(turned.events.filter((e) => e.type === 'popped-out')).toHaveLength(1);
    expect(describeGuideEvent({ type: 'popped-out' })).toMatch(/torque/);
    expect(turned.state.s).toBe(AORTIC_ROOT_S);
  });

  it('pops out on either side', () => {
    expect(run(seated(), spin(-10), 5.5).state.engaged).toBe(false);
  });

  it('does not advance further', () => {
    expect(run(seated(), { advanceSpeed: 80, rotateRate: 0 }, 1).state.s).toBe(AORTIC_ROOT_S);
  });

  it('disengages when withdrawn', () => {
    const out = run(seated(), { advanceSpeed: -30, rotateRate: 0 }, 0.5);
    expect(out.state.engaged).toBe(false);
    expect(out.state.s).toBeLessThan(AORTIC_ROOT_S);
    expect(out.events.filter((e) => e.type === 'disengaged')).toHaveLength(1);
  });

  it('can be re-seated after popping out', () => {
    const popped = run(seated(), spin(10), 4.5).state;
    const back = run(popped, spin(-10), 4.5).state; // rotate back toward the cusp
    expect(run(back, GENTLE, 1).state.engaged).toBe(true);
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const frozen = Object.freeze({ ...atRoot(LEFT) });
    expect(() => stepGuide(frozen, GENTLE, FREE, 0.1)).not.toThrow();
    expect(frozen.seatProgress).toBe(0);
  });
});
