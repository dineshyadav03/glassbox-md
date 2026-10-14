import { describe, expect, it } from 'vitest';
import { ANATOMY } from '../src/config/anatomy';
import { RULES } from '../src/config/rules';
import { BeatClock, DopplerSound, dopplerCue, type AudioContextLike } from '../src/audio/doppler';
import { barDifference, clipAngles, evaluateClip, goodClip } from '../src/physics/clipEval';
import { act, bleedRate, flowing, initialField, tick, type Action, type FieldState, type Target } from '../src/procedure/field';
import { adviceNow } from '../src/procedure/mentor';
import type { ToolId } from '../src/tools/tools';

const NONE: Target = { kind: 'none' };
const NECK: Target = { kind: 'aneurysm', part: 'neck' };
const DOME: Target = { kind: 'aneurysm', part: 'dome' };
const ICA: Target = { kind: 'vessel', id: 'ica' };
const PCOM: Target = { kind: 'vessel', id: 'pcom' };
const use = (tool: ToolId, target: Target): Action => ({ type: 'click', tool, target });

function run(state: FieldState, ...actions: Action[]): FieldState {
  return actions.reduce((s, a) => act(s, a).state, state);
}
const freeNeck = (): FieldState =>
  run(
    initialField(),
    ...RULES.arachnoidOrder.map((id) => use('scissors', { kind: 'arachnoid', id })),
    use('spatula', NONE),
    use('dissector', NECK),
    use('dissector', NECK),
    use('dissector', NECK),
    // Everything before the clip is done, so step 6 is the current step once a clip is on.
    ...(['m1', 'ica', 'pcom', 'achoa'] as const).map((id): Action => ({ type: 'identify', target: { kind: 'vessel', id } })),
    { type: 'identify', target: { kind: 'nerve', id: 'optic' } },
  );
const clipped = (setup: { variant?: 'straight' | 'curved'; angleDeg: number; depth: number }): FieldState =>
  run(freeNeck(), { type: 'setClip', ...setup }, use('clip', NECK));

describe('the angles of this anatomy', () => {
  const angles = clipAngles();

  it('are inside the clip’s range, and put the two branches well apart from the ideal', () => {
    for (const a of [angles.ideal, angles.pcom, angles.achoa]) {
      expect(a).toBeGreaterThan(-90 - 1e-9);
      expect(a).toBeLessThanOrEqual(90);
    }
    expect(barDifference(angles.ideal, angles.pcom)).toBeGreaterThan(RULES.clip.pinchAngleDeg);
    expect(barDifference(angles.ideal, angles.achoa)).toBeGreaterThan(RULES.clip.pinchAngleDeg);
  });

  it('move when the anatomy is edited', () => {
    const copy = structuredClone(ANATOMY) as typeof ANATOMY;
    copy.aneurysm.direction = [0.2, -0.9, -0.4];
    const moved = clipAngles(copy);
    expect(barDifference(moved.ideal, angles.ideal) + barDifference(moved.pcom, angles.pcom)).toBeGreaterThan(5);
  });

  it('compares bar angles modulo half a turn', () => {
    expect(barDifference(80, -80)).toBeCloseTo(20, 9);
    expect(barDifference(0, 90)).toBe(90);
    expect(barDifference(-45, -45)).toBe(0);
  });
});

describe('judging a clip', () => {
  it('closes the neck, spares both branches and the carotid when it lies along the artery at a good depth', () => {
    const r = evaluateClip(goodClip());
    expect(r.closed).toBe(true);
    expect(r.residualMm).toBeLessThan(RULES.clip.closedResidualMm);
    expect(r.pcomOpen).toBe(true);
    expect(r.achoaOpen).toBe(true);
    expect(r.icaNarrowingPct).toBeLessThan(RULES.clip.noticeNarrowingPct);
  });

  it('leaves a residual neck when the blades are too shallow, more so the shallower they are', () => {
    const ideal = goodClip().angleDeg;
    const a = evaluateClip({ variant: 'straight', angleDeg: ideal, depth: 0.5 });
    const b = evaluateClip({ variant: 'straight', angleDeg: ideal, depth: 0.2 });
    expect(a.closed).toBe(false);
    expect(b.residualMm).toBeGreaterThan(a.residualMm);
    expect(b.residualMm).toBeLessThanOrEqual(ANATOMY.aneurysm.neckWidthMm);
  });

  it('narrows the carotid when the blades reach too deep', () => {
    const ideal = goodClip().angleDeg;
    expect(evaluateClip({ variant: 'straight', angleDeg: ideal, depth: 0.9 }).icaNarrowingPct).toBe(0);
    expect(evaluateClip({ variant: 'straight', angleDeg: ideal, depth: 1 }).icaNarrowingPct).toBeCloseTo(RULES.clip.intrusionNarrowing, 6);
  });

  it('pinches the PCom when a deep clip points at it, and the anterior choroidal when it points there, but not a shallow one', () => {
    const angles = clipAngles();
    const atPcom = evaluateClip({ variant: 'straight', angleDeg: angles.pcom, depth: 0.85 });
    expect(atPcom.pcomOpen).toBe(false);
    expect(atPcom.achoaOpen).toBe(true);
    const atAchoa = evaluateClip({ variant: 'straight', angleDeg: angles.achoa, depth: 0.85 });
    expect(atAchoa.achoaOpen).toBe(false);
    expect(evaluateClip({ variant: 'straight', angleDeg: angles.pcom, depth: RULES.clip.pinchDepth - 0.1 }).pcomOpen).toBe(true);
  });

  it('tolerates a larger turn with the curved clip, but wants a deeper bite', () => {
    const angle = clipAngles().ideal + 45;
    const wrapped = angle > 90 ? angle - 180 : angle;
    const straight = evaluateClip({ variant: 'straight', angleDeg: wrapped, depth: 0.85 });
    const curved = evaluateClip({ variant: 'curved', angleDeg: wrapped, depth: 0.85 });
    expect(curved.residualMm).toBeLessThan(straight.residualMm);
    expect(evaluateClip({ variant: 'curved', angleDeg: goodClip().angleDeg, depth: 0.6 }).closed).toBe(false);
    expect(evaluateClip({ variant: 'straight', angleDeg: goodClip().angleDeg, depth: 0.6 }).closed).toBe(true);
  });

  it('has a wide enough set of good angles that a learner can find one', () => {
    let good = 0;
    for (let a = -90; a <= 90; a += 5) {
      const r = evaluateClip({ variant: 'straight', angleDeg: a, depth: 0.85 });
      if (r.closed && r.pcomOpen && r.achoaOpen && r.icaNarrowingPct < RULES.clip.noticeNarrowingPct) good += 1;
    }
    expect(good).toBeGreaterThanOrEqual(5);
    expect(good).toBeLessThan(30);
  });
});

describe('what a clip does to the flow', () => {
  it('stops the sac and keeps every artery when it is good', () => {
    const f = flowing(clipped(goodClip()));
    expect(f.has('aneurysm')).toBe(false);
    for (const id of ['ica', 'm1', 'a1', 'pcom', 'achoa'] as const) expect(f.has(id)).toBe(true);
  });

  it('lets the sac keep filling when the neck is not closed, and says so to the Doppler', () => {
    const s = clipped({ angleDeg: goodClip().angleDeg, depth: 0.3 });
    expect(flowing(s).has('aneurysm')).toBe(true);
    const reading = act(s, use('doppler', DOME));
    expect(reading.events[0]!.text).toContain('still fills');
    expect(reading.state.checks).toEqual(['sac-fills']);
  });

  it('closes off the PCom when the clip pinches it', () => {
    const s = clipped({ angleDeg: clipAngles().pcom, depth: 0.85 });
    expect(flowing(s).has('pcom')).toBe(false);
    expect(act(s, use('doppler', PCOM)).state.checks).toEqual(['pcom-silent']);
  });

  it('starves everything beyond a carotid that is clamped too hard', () => {
    const s = clipped({ angleDeg: goodClip().angleDeg, depth: 1 });
    expect(evaluateClip(s.clip!).icaNarrowingPct).toBeGreaterThanOrEqual(RULES.clip.noticeNarrowingPct);
    const narrow = clipped({ angleDeg: clipAngles().ideal + (clipAngles().ideal < 0 ? 90 : -90), depth: 1 });
    expect(narrow.clip).not.toBeNull();
    if (evaluateClip(narrow.clip!).icaNarrowingPct >= RULES.clip.blockNarrowingPct) expect(flowing(narrow).has('m1')).toBe(false);
  });

  it('notes a narrowed carotid when ICG is used', () => {
    const s = clipped({ angleDeg: goodClip().angleDeg, depth: 1 });
    expect(act(s, use('icg', NONE)).state.checks).toEqual(['icg-checked', 'ica-narrowed']);
    expect(act(clipped(goodClip()), use('icg', NONE)).state.checks).toEqual(['icg-checked']);
  });

  it('forgets the checks when the clip comes off or a new one goes on', () => {
    const s = act(clipped({ angleDeg: goodClip().angleDeg, depth: 0.3 }), use('doppler', DOME)).state;
    expect(s.checks).toEqual(['sac-fills']);
    const off = act(s, { type: 'removeClip' }).state;
    expect(off.checks).toEqual([]);
    expect(run(off, { type: 'setClip', ...goodClip() }, use('clip', NECK)).checks).toEqual([]);
  });

  it('still bleeds a little from a ruptured sac that is clipped but not closed, and not at all if it is closed', () => {
    const burst = (s: FieldState): FieldState => ({ ...s, ruptured: true });
    // The small ooze left at the neck is still there in both cases; it is the rupture's share that differs.
    const ooze = RULES.bleedOozeMlPerSecond;
    expect(bleedRate(burst(clipped(goodClip())))).toBeCloseTo(ooze, 9);
    expect(bleedRate(burst(clipped({ angleDeg: goodClip().angleDeg, depth: 0.3 })))).toBeCloseTo(ooze + RULES.bleedRuptureMlPerSecond * RULES.clip.leakFraction, 9);
  });
});

describe('the mentor after a bad clip', () => {
  it('stays quiet about the clip until the learner has checked it', () => {
    const s = clipped({ angleDeg: goodClip().angleDeg, depth: 0.3 });
    expect(adviceNow(s).hint).not.toContain('still fills');
  });

  it('says what the check found, and how to fix it', () => {
    const base = { angleDeg: goodClip().angleDeg, depth: 0.3 };
    const filling = act(clipped(base), use('doppler', DOME)).state;
    expect(adviceNow(filling).hint).toContain('still fills');
    const pinched = act(clipped({ angleDeg: clipAngles().pcom, depth: 0.85 }), use('doppler', PCOM)).state;
    expect(adviceNow(pinched).hint).toContain('pinching');
    const narrowed = act(clipped({ angleDeg: goodClip().angleDeg, depth: 1 }), use('icg', NONE)).state;
    expect(adviceNow(narrowed).hint).toContain('narrowed');
  });

  it('does not nag while the temporary clip is on, or once the clip is good', () => {
    const filling = act(clipped({ angleDeg: goodClip().angleDeg, depth: 0.3 }), use('doppler', DOME)).state;
    expect(adviceNow(run(filling, use('tempClip', ICA))).hint).not.toContain('still fills');
    expect(adviceNow(act(clipped(goodClip()), use('doppler', DOME)).state).hint).not.toContain('still fills');
  });
});

describe('the Doppler sound', () => {
  class FakeParam {
    value = 0;
    calls: unknown[] = [];
    setValueAtTime(v: number, t: number): void {
      this.calls.push(['set', v, t]);
    }
    linearRampToValueAtTime(v: number, t: number): void {
      this.calls.push(['ramp', v, t]);
    }
  }
  class FakeContext implements AudioContextLike {
    currentTime = 1;
    destination = {};
    state = 'running';
    oscillators = 0;
    createOscillator() {
      this.oscillators += 1;
      return { type: '', frequency: new FakeParam(), connect: () => undefined, start: () => undefined, stop: () => undefined };
    }
    createGain() {
      return { gain: new FakeParam(), connect: () => undefined };
    }
    resume(): void {}
  }

  it('makes a faster, higher, shorter whoosh at a faster heart rate, within sensible limits', () => {
    const slow = dopplerCue(60);
    const fast = dopplerCue(120);
    expect(fast.fromHz).toBeGreaterThan(slow.fromHz);
    expect(fast.seconds).toBeLessThan(slow.seconds + 1e-9);
    expect(slow.fromHz).toBeGreaterThan(slow.toHz);
    expect(dopplerCue(1000).seconds).toBeGreaterThan(0);
    expect(dopplerCue(-5).fromHz).toBeGreaterThan(0);
  });

  it('counts beats from time and heart rate', () => {
    const clock = new BeatClock();
    expect(clock.step(0.5, 60)).toBe(0);
    expect(clock.step(0.5, 60)).toBe(1);
    expect(clock.step(2.1, 60)).toBe(2);
    clock.reset();
    expect(clock.step(0.01, 60)).toBe(1);
  });

  it('plays one whoosh per beat while active, starting at once, and nothing when silent', () => {
    const ctx = new FakeContext();
    const sound = new DopplerSound(() => ctx);
    for (let i = 0; i < 100; i++) sound.tick(0.1, false, 60);
    expect(sound.played).toBe(0);
    expect(ctx.oscillators).toBe(0);
    for (let i = 0; i < 50; i++) sound.tick(0.1, true, 60); // five seconds at 60 bpm
    // One at the start, then one a second (the last may fall just either side of the five-second mark).
    expect(sound.played).toBeGreaterThanOrEqual(5);
    expect(sound.played).toBeLessThanOrEqual(6);
    expect(ctx.oscillators).toBe(sound.played);
  });

  it('starts a fresh beat each time the probe goes back on a vessel, and stops when it comes off', () => {
    const sound = new DopplerSound(() => new FakeContext());
    sound.tick(0.05, true, 72);
    sound.tick(0.05, false, 72);
    sound.tick(0.05, true, 72);
    expect(sound.played).toBe(2);
  });

  it('is silent when switched off, and survives a browser that cannot make an audio context', () => {
    const off = new DopplerSound(() => new FakeContext());
    off.enabled = false;
    off.tick(1, true, 72);
    expect(off.played).toBe(0);
    const broken = new DopplerSound(() => {
      throw new Error('no audio');
    });
    expect(() => broken.tick(1, true, 72)).not.toThrow();
    expect(broken.played).toBe(0);
  });
});

describe('time and the clip together', () => {
  it('lets the temporary clip hide the clip’s effect: with it on nothing flows', () => {
    const s = run(clipped(goodClip()), use('tempClip', ICA));
    expect(flowing(s).size).toBe(0);
    expect(tick(s, 1).tempClip.on).toBe(true);
  });
});
