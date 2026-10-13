/**
 * Makes the sounds: each cue is a short synthesised tone sequence played through the Web Audio API, so there are
 * no audio files to ship. The audio context is passed in, so tests can use a fake one. Off until switched on, and
 * switching it on happens in response to a key press or click, which is what browsers require to start audio.
 */
import type { Cue, CueEvent } from './cues';

/** The parts of an audio context that are used. */
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
  close?(): Promise<void> | void;
}

export interface Tone {
  readonly type: 'sine' | 'square' | 'triangle' | 'sawtooth';
  readonly hz: number;
  /** Seconds from the start of the cue. */
  readonly at: number;
  readonly seconds: number;
  /** 0 to 1, before the master volume. */
  readonly volume: number;
}

/** What each cue sounds like. */
export const RECIPES: Readonly<Record<Cue, readonly Tone[]>> = {
  beep: [{ type: 'sine', hz: 880, at: 0, seconds: 0.07, volume: 0.5 }],
  alarm: [
    { type: 'square', hz: 988, at: 0, seconds: 0.16, volume: 0.45 },
    { type: 'square', hz: 740, at: 0.2, seconds: 0.16, volume: 0.45 },
    { type: 'square', hz: 988, at: 0.4, seconds: 0.16, volume: 0.45 },
  ],
  stage: [
    { type: 'triangle', hz: 523, at: 0, seconds: 0.11, volume: 0.6 },
    { type: 'triangle', hz: 659, at: 0.12, seconds: 0.11, volume: 0.6 },
    { type: 'triangle', hz: 784, at: 0.24, seconds: 0.2, volume: 0.6 },
  ],
  good: [
    { type: 'sine', hz: 660, at: 0, seconds: 0.08, volume: 0.45 },
    { type: 'sine', hz: 880, at: 0.09, seconds: 0.12, volume: 0.45 },
  ],
  warn: [
    { type: 'triangle', hz: 440, at: 0, seconds: 0.12, volume: 0.55 },
    { type: 'triangle', hz: 440, at: 0.17, seconds: 0.12, volume: 0.55 },
  ],
  danger: [
    { type: 'sawtooth', hz: 233, at: 0, seconds: 0.28, volume: 0.5 },
    { type: 'sawtooth', hz: 196, at: 0.3, seconds: 0.36, volume: 0.5 },
  ],
};

const MASTER_VOLUME = 0.18;
/** The cues that must not pile up: a repeat inside this many seconds is dropped. */
const MIN_GAP: Readonly<Partial<Record<Cue, number>>> = { warn: 0.8, danger: 0.8, good: 0.5, stage: 0.5 };

export class SoundEngine {
  private context: AudioContextLike | null = null;
  private on = false;
  private readonly lastPlayed = new Map<Cue, number>();

  constructor(private readonly makeContext: () => AudioContextLike | null) {}

  get enabled(): boolean {
    return this.on;
  }

  /** Turn sound on or off. Turning it on creates the audio context and resumes it, so call it from a key press or click. */
  setEnabled(enabled: boolean): void {
    this.on = enabled;
    if (!enabled) return;
    if (!this.context) this.context = this.makeContext();
    if (this.context && this.context.state === 'suspended') void this.context.resume();
  }

  /** Play a cue now, if sound is on. */
  play(event: CueEvent): void {
    const context = this.context;
    if (!this.on || !context) return;
    const now = context.currentTime;
    const gap = MIN_GAP[event.cue];
    const last = this.lastPlayed.get(event.cue);
    if (gap !== undefined && last !== undefined && now - last < gap) return;
    this.lastPlayed.set(event.cue, now);

    for (const tone of RECIPES[event.cue]) {
      const hz = event.cue === 'beep' && event.pitchHz ? event.pitchHz : tone.hz;
      const start = now + tone.at;
      const end = start + tone.seconds;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(hz, start);
      // A quick rise and fall, so the tone clicks neither on nor off.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(tone.volume * MASTER_VOLUME, start + Math.min(0.01, tone.seconds / 4));
      gain.gain.linearRampToValueAtTime(0, end);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  }

  playAll(events: readonly CueEvent[]): void {
    for (const event of events) this.play(event);
  }

  dispose(): void {
    this.on = false;
    void this.context?.close?.();
    this.context = null;
  }
}

/** The browser's audio context, or null where there is none (so a missing one never throws). */
export function browserAudioContext(): AudioContextLike | null {
  try {
    const Ctor = (window as unknown as { AudioContext?: new () => AudioContextLike; webkitAudioContext?: new () => AudioContextLike }).AudioContext ??
      (window as unknown as { webkitAudioContext?: new () => AudioContextLike }).webkitAudioContext;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}
