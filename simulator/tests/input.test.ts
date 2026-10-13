import { describe, expect, it } from 'vitest';
import { InputState, WHEEL_PULSE_MS, isHeldKey, keyPress, repeats } from '../src/ui/input';

describe('keyPress', () => {
  it('selects the four movable tools with 1 to 4', () => {
    const tools = ['1', '2', '3', '4'].map((k) => (keyPress(k, false) as { action: { tool: string } }).action.tool);
    expect(tools).toEqual(['guide', 'wire', 'balloon', 'stent']);
  });

  it('injects contrast with 5 or C, measures with 7, gives heparin with G', () => {
    for (const key of ['5', 'c', 'C']) expect(keyPress(key, false)).toEqual({ kind: 'action', action: { type: 'inject' } });
    expect(keyPress('7', false)).toEqual({ kind: 'action', action: { type: 'measure' } });
    expect(keyPress('g', false)).toEqual({ kind: 'action', action: { type: 'heparin' } });
  });

  it('cycles the C-arm forward with V and back with Shift+V', () => {
    expect(keyPress('v', false)).toEqual({ kind: 'action', action: { type: 'cycle-carm', direction: 1 } });
    expect(keyPress('V', true)).toEqual({ kind: 'action', action: { type: 'cycle-carm', direction: -1 } });
  });

  it('nudges the C-arm with the arrow keys, five times as far with Shift, and repeats while held', () => {
    expect(keyPress('ArrowRight', false)).toEqual({ kind: 'action', action: { type: 'adjust-carm', laoDeg: 1, cranialDeg: 0 } });
    expect(keyPress('ArrowLeft', true)).toEqual({ kind: 'action', action: { type: 'adjust-carm', laoDeg: -5, cranialDeg: 0 } });
    expect(keyPress('ArrowUp', false)).toEqual({ kind: 'action', action: { type: 'adjust-carm', laoDeg: 0, cranialDeg: 1 } });
    expect(keyPress('ArrowDown', true)).toEqual({ kind: 'action', action: { type: 'adjust-carm', laoDeg: 0, cranialDeg: -5 } });
    expect(repeats('ArrowUp')).toBe(true);
    expect(repeats('g')).toBe(false);
  });

  it('switches between the 3D and X-ray views with Tab', () => {
    expect(keyPress('Tab', false)).toEqual({ kind: 'ui', command: 'toggle-view' });
  });

  it('maps interface keys', () => {
    expect(keyPress('l', false)).toEqual({ kind: 'ui', command: 'toggle-labels' });
    expect(keyPress('f', false)).toEqual({ kind: 'ui', command: 'toggle-follow' });
    expect(keyPress('h', false)).toEqual({ kind: 'ui', command: 'toggle-help' });
    expect(keyPress('m', false)).toEqual({ kind: 'ui', command: 'toggle-mentor' });
    expect(keyPress('Escape', false)).toEqual({ kind: 'ui', command: 'pause' });
  });

  it('leaves the held keys and unknown keys to the held-key path', () => {
    for (const key of ['w', 's', 'a', 'd', 'e', 'q', ' ', '6']) {
      expect(keyPress(key, false)).toBeNull();
      expect(isHeldKey(key)).toBe(true);
    }
    expect(keyPress('z', false)).toBeNull();
    expect(isHeldKey('z')).toBe(false);
  });
});

describe('InputState', () => {
  it('reports nothing held to begin with', () => {
    expect(new InputState().controls(0)).toEqual({ advance: 0, rotate: 0, fine: false, inflate: false, deflate: false, fluoro: false });
  });

  it('turns W/S and A/D into advance and rotate, case-insensitively, and cancels opposite keys', () => {
    const input = new InputState();
    input.keyDown('W');
    expect(input.controls(0).advance).toBe(1);
    input.keyDown('s');
    expect(input.controls(0).advance).toBe(0);
    input.keyUp('W');
    expect(input.controls(0).advance).toBe(-1);
    input.keyDown('D');
    expect(input.controls(0).rotate).toBe(1);
    input.keyDown('a');
    expect(input.controls(0).rotate).toBe(0);
    input.keyUp('d');
    expect(input.controls(0).rotate).toBe(-1);
  });

  it('holds inflate with E, deflate with Q, fine with Shift, and the pedal with Space or 6', () => {
    const input = new InputState();
    input.keyDown('e');
    input.keyDown('Shift');
    input.keyDown(' ');
    expect(input.controls(0)).toMatchObject({ inflate: true, fine: true, fluoro: true, deflate: false });
    input.keyUp(' ');
    input.keyDown('6');
    expect(input.controls(0).fluoro).toBe(true);
    input.keyUp('6');
    input.keyUp('e');
    input.keyDown('q');
    expect(input.controls(0)).toMatchObject({ inflate: false, deflate: true, fluoro: false });
  });

  it('lets on-screen buttons act like keys, and a fine toggle like Shift', () => {
    const input = new InputState();
    input.setHold('advance', true);
    input.setHold('rotate-left', true);
    input.setHold('inflate', true);
    input.setHold('fluoro', true);
    input.fineToggle = true;
    expect(input.controls(0)).toEqual({ advance: 1, rotate: -1, fine: true, inflate: true, deflate: false, fluoro: true });
    input.setHold('advance', false);
    expect(input.controls(0).advance).toBe(0);
  });

  it('moves the device for a short pulse per wheel notch: up advances, down retracts', () => {
    const input = new InputState();
    input.wheel(-100, 1000);
    expect(input.controls(1000).advance).toBe(1);
    expect(input.controls(1000 + WHEEL_PULSE_MS - 1).advance).toBe(1);
    expect(input.controls(1000 + WHEEL_PULSE_MS).advance).toBe(0);
    input.wheel(100, 5000);
    expect(input.controls(5001).advance).toBe(-1);
    input.wheel(0, 9000);
    expect(input.controls(9001).advance).toBe(0);
  });

  it('never exceeds full travel when a key and the wheel both push', () => {
    const input = new InputState();
    input.keyDown('w');
    input.wheel(-1, 0);
    expect(input.controls(1).advance).toBe(1);
  });

  it('forgets everything when released (window blur, pause)', () => {
    const input = new InputState();
    input.keyDown('w');
    input.setHold('inflate', true);
    input.wheel(-1, 0);
    input.releaseAll();
    expect(input.controls(1)).toEqual({ advance: 0, rotate: 0, fine: false, inflate: false, deflate: false, fluoro: false });
  });
});
