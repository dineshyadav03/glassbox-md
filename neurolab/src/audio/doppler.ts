/**
 * The Doppler probe's sound: a short pulsing whoosh on every heartbeat while the probe is on a vessel with blood
 * flowing in it, and silence anywhere else. Synthesised with the Web Audio API (no audio files); the context is passed
 * in, so tests use a fake one. The pitch and the beat come from the heart rate; the pure parts are `dopplerCue` and
 * `BeatClock`.
 */

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
}
export interface OscillatorLike {
  type: string;
  frequency: AudioParamLike;
  connect(node: unknown): unknown;
  start(time: number): void;
  stop(time: number): void;
}
export interface GainLike {
  gain: AudioParamLike;
  connect(node: unknown): unknown;
}
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  readonly state: string;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void> | void;
}

export interface DopplerCue {
  /** Where the whoosh starts and ends, Hz (it sweeps down, like blood moving past the probe). */
  readonly fromHz: number;
  readonly toHz: number;
  readonly seconds: number;
  readonly gain: number;
}

/** The whoosh for a heart rate: faster hearts give a slightly higher, shorter sound. */
export function dopplerCue(heartRate: number): DopplerCue {
  const rate = Math.min(180, Math.max(40, heartRate));
  return { fromHz: 420 + (rate - 72) * 1.5, toHz: 260 + (rate - 72), seconds: Math.min(0.2, (60 / rate) * 0.3), gain: 0.18 };
}

/** Counts heartbeats from elapsed time, saying how many boundaries a step crossed. */
export class BeatClock {
  private phase = 0;

  /** Advance by `dt` seconds at `heartRate` bpm; returns the number of beats that began. */
  step(dt: number, heartRate: number): number {
    this.phase += (dt * heartRate) / 60;
    const beats = Math.floor(this.phase);
    this.phase -= beats;
    return beats;
  }

  reset(): void {
    this.phase = 1; // so the next step starts a beat at once
  }
}

export class DopplerSound {
  private ctx: AudioContextLike | null = null;
  private readonly clock = new BeatClock();
  private wasActive = false;
  /** Number of whooshes played (for tests and for the sound button's state). */
  played = 0;
  enabled = true;

  constructor(private readonly make: () => AudioContextLike) {}

  private context(): AudioContextLike | null {
    if (!this.ctx) {
      try {
        this.ctx = this.make();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Call every frame. `active` is true while the probe is on a vessel with flow. Silent otherwise. */
  tick(dt: number, active: boolean, heartRate: number): void {
    if (!active || !this.enabled) {
      this.wasActive = false;
      return;
    }
    if (!this.wasActive) {
      this.clock.reset();
      this.wasActive = true;
    }
    const beats = this.clock.step(dt, heartRate);
    if (beats > 0) this.whoosh(dopplerCue(heartRate));
  }

  private whoosh(cue: DopplerCue): void {
    const ctx = this.context();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(cue.fromHz, t);
    osc.frequency.linearRampToValueAtTime(cue.toHz, t + cue.seconds);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(cue.gain, t + cue.seconds * 0.2);
    gain.gain.linearRampToValueAtTime(0, t + cue.seconds);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + cue.seconds + 0.02);
    this.played += 1;
  }
}
