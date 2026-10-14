import { describe, expect, it } from 'vitest';
import { RULES } from '../src/config/rules';
import { describeTarget, classifyHit, neckZoneMm, oozeAnchor } from '../src/anatomy/targets';
import { aneurysmGeometry } from '../src/anatomy/aneurysm';
import { ANATOMY } from '../src/config/anatomy';
import { initialField, type FieldState } from '../src/procedure/field';
import { fieldRows, strainWord } from '../src/ui/fieldModel';
import { cursorFor, iconSvg } from '../src/ui/cursors';
import { TOOLS } from '../src/tools/tools';

const row = (state: FieldState, label: string) => fieldRows(state).find((r) => r.label === label)!;

describe('the field readout', () => {
  it('starts calm', () => {
    const rows = fieldRows(initialField());
    expect(rows.map((r) => r.label)).toEqual(['Membrane cut', 'Fissure', 'Neck freed', 'Dome strain', 'Bleeding points', 'Temporary clip', 'Clip', 'Injuries']);
    expect(row(initialField(), 'Fissure').value).toBe('closed');
    expect(row(initialField(), 'Clip').value).toBe('none');
    expect(rows.every((r) => r.tone === 'normal')).toBe(true);
  });

  it('counts cut membrane and shows the fissure and neck as percentages', () => {
    const state = { ...initialField(), cut: [...RULES.arachnoidOrder], retraction: 2 / 3, neckFreed: 0.75 };
    expect(row(state, 'Membrane cut')).toEqual({ label: 'Membrane cut', value: '4 of 4', tone: 'good' });
    expect(row(state, 'Fissure').value).toBe('held open 67%');
    expect(row(state, 'Neck freed')).toMatchObject({ value: '75%', tone: 'good' });
  });

  it('warns as the temporary clip runs long, and shows the total once it is off', () => {
    const on = (seconds: number): FieldState => ({ ...initialField(), tempClip: { on: true, seconds, totalSeconds: seconds } });
    expect(row(on(10), 'Temporary clip')).toMatchObject({ value: 'on, 10 s', tone: 'normal' });
    expect(row(on(RULES.tempClipWarnSeconds), 'Temporary clip').tone).toBe('warn');
    expect(row(on(RULES.tempClipLongSeconds), 'Temporary clip').tone).toBe('bad');
    const off: FieldState = { ...initialField(), tempClip: { on: false, seconds: 0, totalSeconds: 42 } };
    expect(row(off, 'Temporary clip').value).toBe('off (42 s so far)');
  });

  it('describes the clip and flags injuries and bleeding', () => {
    const state: FieldState = {
      ...initialField(),
      clip: { variant: 'curved', angleDeg: 20, depth: 0.8, appliedAt: 1 },
      injuries: [{ target: 'ica', tool: 'bipolar', kind: 'thermal', time: 1 }],
      oozes: [{ id: 'o', on: 'neck', remaining: 1, brisk: false }],
    };
    expect(row(state, 'Clip').value).toBe('curved, 20°, depth 80%');
    expect(row(state, 'Injuries')).toMatchObject({ value: '1', tone: 'bad' });
    expect(row(state, 'Bleeding points')).toMatchObject({ value: '1', tone: 'warn' });
  });

  it('words the dome strain in steps up to ruptured', () => {
    expect(strainWord(0).text).toBe('low');
    expect(strainWord(0.3).text).toBe('rising');
    expect(strainWord(0.7)).toEqual({ text: 'high', tone: 'bad' });
    expect(strainWord(1)).toEqual({ text: 'ruptured', tone: 'bad' });
  });

  it('warns when the lobes have been held apart for a long time', () => {
    const state = { ...initialField(), retraction: 1, retractionSeconds: RULES.retractionWarnSeconds };
    expect(row(state, 'Fissure').tone).toBe('warn');
  });
});

describe('what the pointer is on', () => {
  const g = aneurysmGeometry();

  it('maps mesh names to targets', () => {
    expect(classifyHit('frontal-lobe', [0, 0, 0])).toEqual({ kind: 'lobe', id: 'frontal' });
    expect(classifyHit('temporal-lobe', [0, 0, 0])).toEqual({ kind: 'lobe', id: 'temporal' });
    expect(classifyHit('arach-mid', [0, 0, 0])).toEqual({ kind: 'arachnoid', id: 'arach-mid' });
    expect(classifyHit('m2-upper', [0, 0, 0])).toEqual({ kind: 'vessel', id: 'm2-upper' });
    expect(classifyHit('optic', [0, 0, 0])).toEqual({ kind: 'nerve', id: 'optic' });
    expect(classifyHit('aneurysm-bleb', [0, 0, 0])).toEqual({ kind: 'aneurysm', part: 'bleb' });
    expect(classifyHit('ooze:ooze-neck', [0, 0, 0])).toEqual({ kind: 'ooze', id: 'ooze-neck' });
  });

  it('treats blades, the backdrop and unknown names as nothing', () => {
    for (const name of ['spatula-frontal', 'backdrop', 'temporary-clip', 'whatever']) expect(classifyHit(name, [0, 0, 0])).toEqual({ kind: 'none' });
  });

  it('splits the sac into neck near the carotid and dome beyond', () => {
    const near: [number, number, number] = [g.neckCentre[0] + g.axis[0] * 0.5, g.neckCentre[1] + g.axis[1] * 0.5, g.neckCentre[2] + g.axis[2] * 0.5];
    const far: [number, number, number] = [g.domeCentre[0], g.domeCentre[1], g.domeCentre[2]];
    expect(classifyHit('aneurysm-sac', near)).toEqual({ kind: 'aneurysm', part: 'neck' });
    expect(classifyHit('aneurysm-sac', far)).toEqual({ kind: 'aneurysm', part: 'dome' });
    expect(neckZoneMm()).toBeLessThan(g.heightMm);
    expect(neckZoneMm()).toBeGreaterThan(ANATOMY.aneurysm.stalkMm);
  });

  it('names every kind of target in plain English, and nothing for none', () => {
    expect(describeTarget({ kind: 'none' })).toBe('');
    expect(describeTarget({ kind: 'vessel', id: 'ica' })).toBe('Internal carotid artery');
    expect(describeTarget({ kind: 'aneurysm', part: 'neck' })).toBe('Aneurysm neck');
    expect(describeTarget({ kind: 'aneurysm', part: 'dome' })).toBe('Aneurysm dome');
    expect(describeTarget({ kind: 'nerve', id: 'oculomotor' })).toBe('Oculomotor nerve');
    expect(describeTarget({ kind: 'ooze', id: 'x' })).toBe('Bleeding point');
    expect(describeTarget({ kind: 'lobe', id: 'temporal' })).toBe('Temporal lobe');
    expect(describeTarget({ kind: 'arachnoid', id: 'a' })).toBe('Arachnoid membrane');
  });

  it('puts a neck leak just off the neck and leaves vessel leaks to the scene', () => {
    const anchor = oozeAnchor('neck')!;
    expect(Math.hypot(anchor[0] - g.neckCentre[0], anchor[1] - g.neckCentre[1], anchor[2] - g.neckCentre[2])).toBeCloseTo(0.6, 6);
    expect(oozeAnchor('ica')).toBeNull();
  });
});

describe('the cursors', () => {
  it('draw every tool with a valid, distinct SVG and a cursor value that falls back to a crosshair', () => {
    const seen = new Set<string>();
    for (const tool of TOOLS) {
      const svg = iconSvg(tool.id);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      seen.add(svg);
      expect(cursorFor(tool.id)).toMatch(/^url\("data:image\/svg\+xml,.+"\) 12 12, crosshair$/);
    }
    expect(seen.size).toBe(TOOLS.length);
  });
});
