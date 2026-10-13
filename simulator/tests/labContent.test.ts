import { describe, expect, it } from 'vitest';
import { dialArc, dialPoint } from '../src/ui/gauges';
import { END_CASE_WARNING, GRADE_CLASS, LAB_DISCLAIMER, LAB_LIMITS, NO_WEBGL_MESSAGE, STATUS_WORD } from '../src/ui/labContent';
import { CONTROLS } from '../src/ui/startContent';

describe('dial geometry', () => {
  it('puts 0 degrees at the top, 90 on the right, 180 at the bottom and -90 on the left', () => {
    const top = dialPoint(0, 40);
    expect(top.x).toBeCloseTo(60, 6);
    expect(top.y).toBeCloseTo(20, 6);
    expect(dialPoint(90, 40).x).toBeCloseTo(100, 6);
    expect(dialPoint(180, 40).y).toBeCloseTo(100, 6);
    expect(dialPoint(-90, 40).x).toBeCloseTo(20, 6);
  });

  it('draws a short arc as a small arc and a wide one as a large arc', () => {
    expect(dialArc(35, 85, 50)).toMatch(/A 50 50 0 0 1/);
    expect(dialArc(0, 270, 50)).toMatch(/A 50 50 0 1 1/);
  });

  it('starts the arc at its first angle', () => {
    const start = dialPoint(35, 50);
    expect(dialArc(35, 85, 50).startsWith(`M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`)).toBe(true);
  });
});

describe('lab text', () => {
  it('keeps the educational disclaimer on the lab screen', () => {
    const text = LAB_DISCLAIMER.toLowerCase();
    expect(text).toContain('educational');
    expect(text).toContain('not clinical training');
    expect(text).toContain('not medical advice');
  });

  it('says plainly what is not built yet', () => {
    expect(LAB_LIMITS.toLowerCase()).toContain('not built yet');
    expect(LAB_LIMITS).not.toMatch(/demo/);
    expect(LAB_LIMITS).toMatch(/sound/);
    expect(LAB_LIMITS).toMatch(/simplified/);
  });

  it('tells the user how to recover when WebGL is missing, and warns before ending a case', () => {
    expect(NO_WEBGL_MESSAGE).toContain('WebGL');
    expect(END_CASE_WARNING.toLowerCase()).toContain('incomplete');
  });

  it('has a colour class for every grade the debrief can give, and a word for each status', () => {
    for (const grade of ['Excellent', 'Good', 'Acceptable', 'Needs work', 'Incomplete']) expect(GRADE_CLASS[grade]).toBeTruthy();
    expect(Object.keys(STATUS_WORD).sort()).toEqual(['bad', 'ok', 'warn']);
  });

  it('does not claim keys that are not built: only sound is marked as such in the controls list', () => {
    const text = CONTROLS.map(([k, v]) => `${k} ${v}`).join('\n');
    expect(text).toMatch(/sound not built yet/);
    expect(text).not.toMatch(/X-ray view not built yet/);
    expect(text).toMatch(/Tab Switch between the 3D view and the X-ray view/);
    expect(text).toMatch(/arrow keys/);
  });
});
