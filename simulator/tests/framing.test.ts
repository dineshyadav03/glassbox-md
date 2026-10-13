import { describe, expect, it } from 'vitest';
import { HEART_LABEL_RANGE, boxFramingDistance, cardiacPhase, easeInOut, framingDistance, isOnScreen, labelShownAt, ndcToPixels } from '../src/scene/framing';

describe('framingDistance', () => {
  it('puts a sphere exactly in view for a wide screen, with the margin', () => {
    const d = framingDistance(60, 40, 16 / 9, 1);
    // The sphere's angular radius seen from d should equal half the vertical field of view.
    expect(Math.asin(60 / d)).toBeCloseTo((40 * Math.PI) / 360, 6);
  });

  it('backs further off on a narrow (portrait) screen, where the width is the limit', () => {
    expect(framingDistance(60, 40, 0.5)).toBeGreaterThan(framingDistance(60, 40, 2));
  });

  it('is larger for a bigger object and with more margin', () => {
    expect(framingDistance(300, 40, 1.5)).toBeGreaterThan(framingDistance(60, 40, 1.5));
    expect(framingDistance(60, 40, 1.5, 1.4)).toBeGreaterThan(framingDistance(60, 40, 1.5, 1.1));
  });

  it('survives a zero-size container', () => {
    expect(Number.isFinite(framingDistance(60, 40, 0))).toBe(true);
  });
});

describe('boxFramingDistance', () => {
  it('is set by the height for a tall box on a wide screen, and by the width on a narrow one', () => {
    const tall = boxFramingDistance(100, 300, 0, 40, 2, 1);
    expect(tall).toBeCloseTo(300 / Math.tan((40 * Math.PI) / 360), 6);
    const narrow = boxFramingDistance(100, 50, 0, 40, 0.5, 1);
    expect(narrow).toBeCloseTo(100 / (Math.tan((40 * Math.PI) / 360) * 0.5), 6);
  });

  it('fits a tall thin box much closer than its bounding sphere would allow', () => {
    // Wrist-to-heart route: about 260 wide and 620 tall. A sphere around it has radius about 340.
    const box = boxFramingDistance(130, 310, 40, 38, 1.7);
    const sphere = framingDistance(Math.hypot(130, 310, 40), 38, 1.7);
    expect(box).toBeLessThanOrEqual(sphere);
  });

  it('backs off for depth and margin', () => {
    expect(boxFramingDistance(50, 50, 40, 40, 1)).toBeGreaterThan(boxFramingDistance(50, 50, 0, 40, 1));
    expect(boxFramingDistance(50, 50, 0, 40, 1, 1.3)).toBeGreaterThan(boxFramingDistance(50, 50, 0, 40, 1, 1.1));
  });
});

describe('labelShownAt', () => {
  it('always shows body labels and shows heart labels only when zoomed in', () => {
    expect(labelShownAt('body', 5000)).toBe(true);
    expect(labelShownAt('heart', HEART_LABEL_RANGE)).toBe(true);
    expect(labelShownAt('heart', HEART_LABEL_RANGE + 1)).toBe(false);
  });

  it('shows heart labels at the heart-framing distance but not at the whole-route distance', () => {
    const heartView = framingDistance(60, 38, 1.7);
    const routeView = boxFramingDistance(130, 310, 40, 38, 1.7);
    expect(labelShownAt('heart', heartView)).toBe(true);
    expect(labelShownAt('heart', routeView)).toBe(false);
  });
});

describe('easeInOut', () => {
  it('runs from 0 to 1, gently, and clamps', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(-3)).toBe(0);
    expect(easeInOut(9)).toBe(1);
  });
});

describe('isOnScreen', () => {
  it('accepts the middle, rejects the edges, off-screen and behind-camera points', () => {
    expect(isOnScreen(0, 0, 0.5)).toBe(true);
    expect(isOnScreen(1.2, 0, 0.5)).toBe(false);
    expect(isOnScreen(0, -1, 0.5)).toBe(false);
    expect(isOnScreen(0, 0, 1.5)).toBe(false);
    expect(isOnScreen(0, 0, -1.5)).toBe(false);
  });
});

describe('ndcToPixels', () => {
  it('maps the corners and centre, with y flipped for the screen', () => {
    expect(ndcToPixels(0, 0, 800, 400)).toEqual({ x: 400, y: 200 });
    expect(ndcToPixels(-1, 1, 800, 400)).toEqual({ x: 0, y: 0 });
    expect(ndcToPixels(1, -1, 800, 400)).toEqual({ x: 800, y: 400 });
  });
});

describe('cardiacPhase', () => {
  it('completes one cycle per beat period', () => {
    expect(cardiacPhase(0, 72)).toBe(0);
    expect(cardiacPhase(60 / 72 / 2, 72)).toBeCloseTo(0.5, 9);
    expect(cardiacPhase(60 / 72, 72)).toBeCloseTo(0, 9);
  });

  it('stays within [0, 1) and tolerates negative time and a silly heart rate', () => {
    for (const t of [-5.3, -0.01, 0, 1.7, 123.456]) {
      const p = cardiacPhase(t, 72);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
    expect(Number.isFinite(cardiacPhase(3, 0))).toBe(true);
  });
});
