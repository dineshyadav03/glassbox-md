import { describe, expect, it } from 'vitest';
import { act, createSimulation, tick } from '../src/engine/simulation';
import {
  ALARM_EVERY_SECONDS,
  HeartbeatClock,
  Metronome,
  SoundDriver,
  beepPitch,
  messageCues,
  newMessages,
} from '../src/audio/cues';
import { RECIPES, SoundEngine, type AudioContextLike, type OscillatorLike } from '../src/audio/sound';
import { vitalsOf } from '../src/physics/physiology';
import { NO_CONTROLS } from '../src/engine/simulation';
import { Player, playGoodCase } from './helpers/player';

describe('beepPitch', () => {
  it('is the normal pitch at a normal saturation and falls as it falls, but never below a floor', () => {
    expect(beepPitch(98)).toBe(880);
    expect(beepPitch(94)).toBeLessThan(beepPitch(98));
    expect(beepPitch(90)).toBeLessThan(beepPitch(94));
    expect(beepPitch(40)).toBe(440);
    expect(beepPitch(100)).toBe(880);
  });
});

describe('HeartbeatClock', () => {
  it('completes about one beat per 60/bpm seconds, at any frame length', () => {
    for (const dt of [0.016, 0.05, 0.25]) {
      const clock = new HeartbeatClock();
      let beats = 0;
      for (let t = 0; t < 60; t += dt) beats += clock.advance(dt, 72);
      expect(beats).toBeGreaterThanOrEqual(71);
      expect(beats).toBeLessThanOrEqual(73);
    }
  });

  it('follows a changing rate and never counts negative time or a negative rate', () => {
    const clock = new HeartbeatClock();
    let slow = 0;
    for (let t = 0; t < 10; t += 0.05) slow += clock.advance(0.05, 60);
    let fast = 0;
    for (let t = 0; t < 10; t += 0.05) fast += clock.advance(0.05, 120);
    expect(fast).toBeGreaterThan(slow * 1.8);
    expect(clock.advance(-1, 72)).toBe(0);
    expect(clock.advance(1, -50)).toBe(0);
  });
});

describe('Metronome', () => {
  it('sounds at once when switched on, then at its interval, and stops when switched off', () => {
    const m = new Metronome(1);
    expect(m.tick(false, 0.1)).toBe(false);
    expect(m.tick(true, 0.1)).toBe(true);
    let fired = 0;
    // 3.5 s of 0.1 s steps (a little over, so floating-point drift in the sums cannot change the count)
    for (let i = 0; i < 35; i++) if (m.tick(true, 0.1)) fired++;
    expect(fired).toBe(3);
    expect(m.tick(false, 0.1)).toBe(false);
    expect(m.tick(true, 0.1)).toBe(true); // restarts promptly
  });
});

describe('message cues', () => {
  it('gives no cue when nothing happened, and none for plain information', () => {
    const sim = createSimulation();
    expect(messageCues(sim, sim)).toEqual([]);
    const info = act(sim, { type: 'narrate', text: 'Hello.' });
    expect(messageCues(sim, info)).toEqual([]);
  });

  it('gives a warning cue for a refused tool and a danger cue for a rupture', () => {
    const sim = createSimulation();
    expect(messageCues(sim, act(sim, { type: 'select-tool', tool: 'wire' }))).toEqual([{ cue: 'warn' }]);
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) >= 40, 30);
    p.until({ inflate: true }, (s) => s.balloon.pressure > 17, 20);
    const before = p.sim;
    p.until({ inflate: true }, (s) => s.balloon.ruptured, 20);
    expect(messageCues(before, p.sim)).toEqual([{ cue: 'danger' }]);
  });

  it('chimes when a step is completed, instead of the "good" message that comes with it', () => {
    const p = new Player().hold({ rotate: 1 }, 1);
    let seen = 0;
    for (let i = 0; i < 4000 && p.sim.progress.completedAt[0] === null; i++) {
      const before = p.sim;
      // Step 1 also needs a look on fluoroscopy once past the elbow.
      p.sim = tick(p.sim, { ...NO_CONTROLS, advance: 1, fluoro: p.sim.guide.s > 300 }, 0.05);
      const cues = messageCues(before, p.sim);
      if (p.sim.progress.completedAt[0] !== null && before.progress.completedAt[0] === null) {
        expect(cues).toEqual([{ cue: 'stage' }]);
        seen++;
      }
    }
    expect(seen).toBe(1);
  });

  it('finds exactly the new messages, even when the log has been trimmed', () => {
    let sim = createSimulation();
    const before = sim;
    sim = act(act(sim, { type: 'narrate', text: 'one' }), { type: 'narrate', text: 'two' });
    expect(newMessages(before, sim).map((m) => m.text)).toEqual(['Demo: one', 'Demo: two']);
    // Fill past the log's limit: the previous last message may no longer be there.
    let full = sim;
    for (let i = 0; i < 80; i++) full = act({ ...full, time: full.time + 4 }, { type: 'narrate', text: `line ${i}` });
    expect(newMessages(sim, full).length).toBeGreaterThan(0);
    expect(newMessages(full, full)).toEqual([]);
  });
});

describe('SoundDriver', () => {
  it('beeps about once per heartbeat for a stable patient and never alarms', () => {
    const driver = new SoundDriver();
    let sim = createSimulation();
    const counts: Record<string, number> = {};
    for (let t = 0; t < 30; t += 0.05) {
      const next = tick(sim, NO_CONTROLS, 0.05);
      for (const e of driver.update(sim, next, 0.05)) counts[e.cue] = (counts[e.cue] ?? 0) + 1;
      sim = next;
    }
    expect(counts.beep).toBeGreaterThanOrEqual(34);
    expect(counts.beep).toBeLessThanOrEqual(38);
    expect(counts.alarm).toBeUndefined();
  });

  it('sounds the alarm repeatedly once the patient is unstable, and not before', () => {
    const p = playGoodCase({ stopAfterWire: true }).do({ type: 'select-tool', tool: 'balloon' });
    p.until({ advance: 1 }, (s) => (s.balloon.centreS ?? 0) >= 47, 30);
    p.until({ inflate: true }, (s) => s.balloon.pressure >= 10, 20);
    const driver = new SoundDriver();
    let alarms = 0;
    let firstAlarmAt = Infinity;
    let sim = p.sim;
    for (let i = 0; i < 1600; i++) {
      const next = tick(sim, NO_CONTROLS, 0.05);
      const cues = driver.update(sim, next, 0.05);
      if (cues.some((c) => c.cue === 'alarm')) {
        alarms++;
        firstAlarmAt = Math.min(firstAlarmAt, next.time);
      }
      sim = next;
    }
    expect(vitalsOf(sim.patient).unstable).toBe(true);
    expect(alarms).toBeGreaterThanOrEqual(3);
    // It starts when the patient becomes unstable (60 s of occlusion), not earlier.
    expect(sim.patient.occludedSeconds).toBeGreaterThan(60);
    expect(firstAlarmAt).toBeGreaterThan(p.sim.time + 50);
    expect(ALARM_EVERY_SECONDS).toBeGreaterThan(1);
  });

  it('lowers the beep pitch as saturation falls', () => {
    const driver = new SoundDriver();
    const base = createSimulation();
    const low = { ...base, patient: { ...base.patient, occludedSeconds: 100 } };
    const pitches: number[] = [];
    for (let i = 0; i < 100; i++) for (const e of driver.update(low, low, 0.05)) if (e.cue === 'beep') pitches.push(e.pitchHz!);
    expect(pitches.length).toBeGreaterThan(0);
    expect(Math.max(...pitches)).toBeLessThan(880);
  });

  it('is silent once the case has ended', () => {
    const done = playGoodCase().sim;
    expect(new SoundDriver().update(done, done, 0.05)).toEqual([]);
  });
});

// --- the audio engine, against a fake audio context --------------------------------------------------------------------

interface Played {
  type: string;
  hz: number;
  start: number;
  stop: number;
  peak: number;
}

function fakeContext(): { context: AudioContextLike; played: Played[]; resumed: () => number; set time(t: number); closed: () => boolean } {
  const played: Played[] = [];
  let resumes = 0;
  let now = 0;
  let closed = false;
  const context: AudioContextLike = {
    get currentTime() {
      return now;
    },
    destination: {},
    state: 'suspended',
    createOscillator(): OscillatorLike {
      const entry: Played = { type: '', hz: 0, start: 0, stop: 0, peak: 0 };
      played.push(entry);
      return {
        set type(v: string) {
          entry.type = v;
        },
        get type() {
          return entry.type;
        },
        frequency: { value: 0, setValueAtTime: (v: number) => void (entry.hz = v), linearRampToValueAtTime: () => undefined },
        connect: (node: unknown) => node,
        start: (t: number) => void (entry.start = t),
        stop: (t: number) => void (entry.stop = t),
      };
    },
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: (v: number) => {
            const last = played[played.length - 1];
            if (last) last.peak = Math.max(last.peak, v);
          },
        },
        connect: (node: unknown) => node,
      };
    },
    resume: () => void (resumes += 1),
    close: () => void (closed = true),
  };
  return {
    context,
    played,
    resumed: () => resumes,
    set time(t: number) {
      now = t;
    },
    closed: () => closed,
  };
}

describe('SoundEngine', () => {
  it('is silent until it is switched on, and does not even create a context before then', () => {
    let made = 0;
    const engine = new SoundEngine(() => {
      made++;
      return fakeContext().context;
    });
    engine.play({ cue: 'beep' });
    expect(engine.enabled).toBe(false);
    expect(made).toBe(0);
  });

  it('creates and resumes the context when switched on, and plays the cue as scheduled tones', () => {
    const fake = fakeContext();
    const engine = new SoundEngine(() => fake.context);
    engine.setEnabled(true);
    expect(fake.resumed()).toBe(1);
    engine.play({ cue: 'stage' });
    expect(fake.played).toHaveLength(RECIPES.stage.length);
    expect(fake.played.map((p) => p.hz)).toEqual(RECIPES.stage.map((t) => t.hz));
    for (const p of fake.played) {
      expect(p.stop).toBeGreaterThan(p.start);
      expect(p.peak).toBeGreaterThan(0);
      expect(p.peak).toBeLessThan(0.25); // quiet: the master volume is low
    }
  });

  it('uses the pitch given for the monitor beep', () => {
    const fake = fakeContext();
    const engine = new SoundEngine(() => fake.context);
    engine.setEnabled(true);
    engine.play({ cue: 'beep', pitchHz: 700 });
    expect(fake.played[0]!.hz).toBe(700);
  });

  it('plays nothing after being switched off, and plays again when switched back on', () => {
    const fake = fakeContext();
    const engine = new SoundEngine(() => fake.context);
    engine.setEnabled(true);
    engine.setEnabled(false);
    engine.play({ cue: 'beep' });
    expect(fake.played).toHaveLength(0);
    engine.setEnabled(true);
    engine.play({ cue: 'beep' });
    expect(fake.played).toHaveLength(1);
  });

  it('drops a repeated warning that comes too soon, but not one after the gap, and never drops a beep', () => {
    const fake = fakeContext();
    const engine = new SoundEngine(() => fake.context);
    engine.setEnabled(true);
    engine.play({ cue: 'warn' });
    const first = fake.played.length;
    fake.time = 0.2;
    engine.play({ cue: 'warn' });
    expect(fake.played.length).toBe(first);
    fake.time = 1.5;
    engine.play({ cue: 'warn' });
    expect(fake.played.length).toBe(first * 2);
    const beeps = fake.played.length;
    engine.play({ cue: 'beep' });
    engine.play({ cue: 'beep' });
    expect(fake.played.length).toBe(beeps + 2);
  });

  it('survives a browser with no audio, and cleans up', () => {
    const none = new SoundEngine(() => null);
    expect(() => none.setEnabled(true)).not.toThrow();
    expect(() => none.play({ cue: 'danger' })).not.toThrow();
    const fake = fakeContext();
    const engine = new SoundEngine(() => fake.context);
    engine.setEnabled(true);
    engine.dispose();
    expect(fake.closed()).toBe(true);
    expect(engine.enabled).toBe(false);
  });

  it('has a recipe for every cue, each a few tones, all audible and short', () => {
    for (const cue of Object.keys(RECIPES) as (keyof typeof RECIPES)[]) {
      const tones = RECIPES[cue];
      expect(tones.length).toBeGreaterThan(0);
      for (const t of tones) {
        expect(t.hz).toBeGreaterThan(100);
        expect(t.hz).toBeLessThan(2000);
        expect(t.at + t.seconds).toBeLessThan(1);
        expect(t.volume).toBeGreaterThan(0);
        expect(t.volume).toBeLessThanOrEqual(1);
      }
    }
  });
});
