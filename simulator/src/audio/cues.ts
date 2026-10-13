/**
 * When to make a sound. Pure: given the case a moment ago and now, which cues should play. No audio here, so it is
 * all unit tested; `sound.ts` turns a cue into noise.
 */
import { PHYSIOLOGY } from '../config/anatomy';
import type { Message, Simulation } from '../engine/simulation';
import { vitalsOf } from '../physics/physiology';

export type Cue = 'beep' | 'alarm' | 'stage' | 'good' | 'warn' | 'danger';

export interface CueEvent {
  readonly cue: Cue;
  /** For the monitor beep: its pitch, which falls as oxygen saturation falls. */
  readonly pitchHz?: number;
}

/** Pitch of the monitor beep, Hz: a pulse oximeter's tone drops as the saturation does. */
export function beepPitch(spo2: number): number {
  return Math.max(440, 880 - Math.max(0, PHYSIOLOGY.baseSpo2 - spo2) * 40);
}

/** Counts heartbeats as time passes, following a heart rate that may change from moment to moment. */
export class HeartbeatClock {
  private phase = 0.7; // start part-way through a beat so the first beep is not instant

  /** Advance by `dt` seconds at `bpm`; returns how many beats completed. */
  advance(dt: number, bpm: number): number {
    this.phase += (Math.max(0, bpm) / 60) * Math.max(0, dt);
    const beats = Math.floor(this.phase);
    this.phase -= beats;
    return beats;
  }
}

/** Fires at a fixed interval while switched on, and restarts when switched off. */
export class Metronome {
  private elapsed = 0;

  constructor(private readonly everySeconds: number) {}

  /** Advance by `dt`; returns true if it is time to sound again. The first call after switching on sounds at once. */
  tick(on: boolean, dt: number): boolean {
    if (!on) {
      this.elapsed = this.everySeconds;
      return false;
    }
    this.elapsed += Math.max(0, dt);
    if (this.elapsed >= this.everySeconds) {
      this.elapsed = 0;
      return true;
    }
    return false;
  }
}

/** The messages added between two states of the same case. */
export function newMessages(prev: Simulation, next: Simulation): readonly Message[] {
  const last = prev.messages[prev.messages.length - 1];
  if (!last) return next.messages;
  for (let i = next.messages.length - 1; i >= 0; i--) {
    const m = next.messages[i]!;
    if (m.t === last.t && m.text === last.text) return next.messages.slice(i + 1);
  }
  return next.messages.filter((m) => m.t > last.t);
}

const completedSteps = (sim: Simulation): number => sim.progress.completedAt.filter((t) => t !== null).length;

/**
 * The cues for one change of state: a chime when a step is completed, otherwise the most serious of the new
 * messages (danger over warning over good). Plain information makes no sound.
 */
export function messageCues(prev: Simulation, next: Simulation): CueEvent[] {
  if (completedSteps(next) > completedSteps(prev)) return [{ cue: 'stage' }];
  const fresh = newMessages(prev, next);
  if (fresh.some((m) => m.level === 'bad')) return [{ cue: 'danger' }];
  if (fresh.some((m) => m.level === 'warn')) return [{ cue: 'warn' }];
  if (fresh.some((m) => m.level === 'good')) return [{ cue: 'good' }];
  return [];
}

/** How often the alarm repeats while the patient is unstable, seconds. */
export const ALARM_EVERY_SECONDS = 1.4;

/** Keeps the clocks that the monitor sounds need, and turns each frame into the cues to play. */
export class SoundDriver {
  private readonly heart = new HeartbeatClock();
  private readonly alarm = new Metronome(ALARM_EVERY_SECONDS);

  update(prev: Simulation, next: Simulation, dt: number): CueEvent[] {
    if (next.ended && prev.ended) return [];
    const cues: CueEvent[] = [...messageCues(prev, next)];
    const vitals = vitalsOf(next.patient);
    const beats = this.heart.advance(dt, vitals.heartRate);
    if (beats > 0) cues.push({ cue: 'beep', pitchHz: beepPitch(vitals.spo2) });
    if (this.alarm.tick(vitals.alarm, dt)) cues.push({ cue: 'alarm' });
    return cues;
  }
}
