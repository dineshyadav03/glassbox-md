/**
 * Turning keys, on-screen hold buttons and the mouse wheel into the engine's `Controls`, and one-off
 * key presses into engine actions or interface commands. The pure parts are unit tested; `InputState`
 * holds no DOM references, the lab screen feeds it events.
 */
import { CARM } from '../config/anatomy';
import type { Action, Controls } from '../engine/simulation';

/** Things the interface itself does (not the simulation). */
export type UiCommand = 'toggle-labels' | 'toggle-follow' | 'toggle-help' | 'toggle-mentor' | 'toggle-view' | 'toggle-sound' | 'pause';

export type KeyResult = { readonly kind: 'action'; readonly action: Action } | { readonly kind: 'ui'; readonly command: UiCommand };

const nudge = (laoDeg: number, cranialDeg: number): KeyResult => ({ kind: 'action', action: { type: 'adjust-carm', laoDeg, cranialDeg } });

/** Keys that repeat while held (the arrow keys keep nudging the C-arm); every other press fires once. */
export function repeats(key: string): boolean {
  return key.toLowerCase().startsWith('arrow');
}

/** What a single press of this key does, or null if it is only a held key or unused. */
export function keyPress(key: string, shift: boolean): KeyResult | null {
  switch (key.toLowerCase()) {
    case '1':
      return { kind: 'action', action: { type: 'select-tool', tool: 'guide' } };
    case '2':
      return { kind: 'action', action: { type: 'select-tool', tool: 'wire' } };
    case '3':
      return { kind: 'action', action: { type: 'select-tool', tool: 'balloon' } };
    case '4':
      return { kind: 'action', action: { type: 'select-tool', tool: 'stent' } };
    case '5':
    case 'c':
      return { kind: 'action', action: { type: 'inject' } };
    case '7':
      return { kind: 'action', action: { type: 'measure' } };
    case 'g':
      return { kind: 'action', action: { type: 'heparin' } };
    case 'v':
      return { kind: 'action', action: { type: 'cycle-carm', direction: shift ? -1 : 1 } };
    case 'arrowright':
      return nudge(shift ? CARM.coarseStepDeg : CARM.fineStepDeg, 0);
    case 'arrowleft':
      return nudge(-(shift ? CARM.coarseStepDeg : CARM.fineStepDeg), 0);
    case 'arrowup':
      return nudge(0, shift ? CARM.coarseStepDeg : CARM.fineStepDeg);
    case 'arrowdown':
      return nudge(0, -(shift ? CARM.coarseStepDeg : CARM.fineStepDeg));
    case 'tab':
      return { kind: 'ui', command: 'toggle-view' };
    case 'l':
      return { kind: 'ui', command: 'toggle-labels' };
    case 'f':
      return { kind: 'ui', command: 'toggle-follow' };
    case 'h':
      return { kind: 'ui', command: 'toggle-help' };
    case 'm':
      return { kind: 'ui', command: 'toggle-mentor' };
    case 'n':
      return { kind: 'ui', command: 'toggle-sound' };
    case 'escape':
      return { kind: 'ui', command: 'pause' };
    default:
      return null;
  }
}

/** The keys that are held, not pressed. */
const HELD_KEYS = new Set(['w', 's', 'a', 'd', 'e', 'q', ' ', '6', 'shift']);

export function isHeldKey(key: string): boolean {
  return HELD_KEYS.has(key.toLowerCase());
}

/** Buttons on the screen that act while the pointer is down. */
export type HoldButton = 'advance' | 'retract' | 'rotate-left' | 'rotate-right' | 'inflate' | 'deflate' | 'fluoro';

/** How long one notch of the mouse wheel moves the device, ms. */
export const WHEEL_PULSE_MS = 140;

export class InputState {
  private readonly keys = new Set<string>();
  private readonly holds = new Set<HoldButton>();
  private wheelDirection: -1 | 0 | 1 = 0;
  private wheelUntil = 0;
  /** Fine control toggled by an on-screen button (Shift does the same while held). */
  fineToggle = false;

  keyDown(key: string): void {
    this.keys.add(key.toLowerCase());
  }

  keyUp(key: string): void {
    this.keys.delete(key.toLowerCase());
  }

  setHold(button: HoldButton, down: boolean): void {
    if (down) this.holds.add(button);
    else this.holds.delete(button);
  }

  /** A wheel notch: scrolling up (negative deltaY) advances, down retracts. */
  wheel(deltaY: number, nowMs: number): void {
    if (deltaY === 0) return;
    this.wheelDirection = deltaY < 0 ? 1 : -1;
    this.wheelUntil = nowMs + WHEEL_PULSE_MS;
  }

  /** Forget everything held, for when the window loses focus or the game pauses. */
  releaseAll(): void {
    this.keys.clear();
    this.holds.clear();
    this.wheelDirection = 0;
    this.wheelUntil = 0;
  }

  controls(nowMs: number): Controls {
    const down = (k: string): boolean => this.keys.has(k);
    const axis = (plus: boolean, minus: boolean): number => (plus ? 1 : 0) - (minus ? 1 : 0);
    const wheel = nowMs < this.wheelUntil ? this.wheelDirection : 0;
    const advance = Math.max(-1, Math.min(1, axis(down('w') || this.holds.has('advance'), down('s') || this.holds.has('retract')) + wheel));
    const rotate = axis(down('d') || this.holds.has('rotate-right'), down('a') || this.holds.has('rotate-left'));
    return {
      advance,
      rotate,
      fine: down('shift') || this.fineToggle,
      inflate: down('e') || this.holds.has('inflate'),
      deflate: down('q') || this.holds.has('deflate'),
      fluoro: down(' ') || down('6') || this.holds.has('fluoro'),
    };
  }
}
