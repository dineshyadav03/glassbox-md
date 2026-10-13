import { describe, expect, it } from 'vitest';
import {
  buildDebrief,
  gradeFromScore,
  type DebriefItem,
  type ProcedureSummary,
  type Status,
} from '../src/procedure/evaluation';

/** A flawless case: every item is "ok". */
const PERFECT: ProcedureSummary = {
  completed: true,
  residualStenosis: 0,
  finalTimi: 3,
  stentDiameterRatio: 1.03,
  proximalMarginMm: 2,
  distalMarginMm: 2,
  stentsDeployed: 1,
  heparin: 'before-wire',
  predilated: true,
  qcaUsed: true,
  dissection: 'none',
  wireForcingSeconds: 0,
  balloonRuptures: 0,
  longestInflationS: 12,
  contrastMl: 60,
  fluoroSeconds: 240,
  finalViews: 2,
};

const statusOf = (summary: ProcedureSummary, id: string): Status =>
  buildDebrief(summary).items.find((i) => i.id === id)!.status;

const withIt = (overrides: Partial<ProcedureSummary>): ProcedureSummary => ({ ...PERFECT, ...overrides });

describe('a flawless case', () => {
  const debrief = buildDebrief(PERFECT);

  it('scores 100 and is Excellent, with nothing capping it', () => {
    expect(debrief.score).toBe(100);
    expect(debrief.grade).toBe('Excellent');
    expect(debrief.cappedBy).toEqual([]);
    expect(debrief.headline).toMatch(/^Excellent/);
  });

  it('has the fifteen specified items, all ok, weighted to 100', () => {
    expect(debrief.items.map((i) => i.id)).toEqual([
      'residual', 'timi', 'stent-size', 'coverage', 'extra-stents', 'heparin', 'predilation', 'qca',
      'dissection', 'forcing', 'rupture', 'inflation', 'contrast', 'fluoro', 'views',
    ]);
    expect(debrief.items.every((i) => i.status === 'ok' && i.points === i.maxPoints)).toBe(true);
    expect(debrief.items.reduce((sum, i) => sum + i.maxPoints, 0)).toBe(100);
  });

  it('gives every item a value and a one-or-two-sentence teaching point', () => {
    for (const i of debrief.items) {
      expect(i.value.length).toBeGreaterThan(0);
      expect(i.teaching.length).toBeGreaterThan(30);
      const sentences = i.teaching.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(sentences.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('thresholds, each item', () => {
  const cases: [string, Partial<ProcedureSummary>, Status][] = [
    ['residual', { residualStenosis: 0.1 }, 'ok'],
    ['residual', { residualStenosis: 0.11 }, 'warn'],
    ['residual', { residualStenosis: 0.3 }, 'warn'],
    ['residual', { residualStenosis: 0.31 }, 'bad'],
    ['residual', { residualStenosis: null }, 'bad'],

    ['timi', { finalTimi: 3 }, 'ok'],
    ['timi', { finalTimi: 2 }, 'warn'],
    ['timi', { finalTimi: 1 }, 'bad'],
    ['timi', { finalTimi: 0 }, 'bad'],
    ['timi', { finalTimi: null }, 'bad'],

    ['stent-size', { stentDiameterRatio: 0.95 }, 'ok'],
    ['stent-size', { stentDiameterRatio: 1.15 }, 'ok'],
    ['stent-size', { stentDiameterRatio: 0.949 }, 'warn'],
    ['stent-size', { stentDiameterRatio: 0.85 }, 'warn'],
    ['stent-size', { stentDiameterRatio: 0.849 }, 'bad'],
    ['stent-size', { stentDiameterRatio: 1.151 }, 'warn'],
    ['stent-size', { stentDiameterRatio: 1.2 }, 'warn'],
    ['stent-size', { stentDiameterRatio: 1.201 }, 'bad'],
    ['stent-size', { stentDiameterRatio: null }, 'bad'],

    ['coverage', { proximalMarginMm: 1.5, distalMarginMm: 1.5 }, 'ok'],
    ['coverage', { proximalMarginMm: 1.49, distalMarginMm: 3 }, 'warn'],
    ['coverage', { proximalMarginMm: 3, distalMarginMm: 0 }, 'warn'],
    ['coverage', { proximalMarginMm: -0.1, distalMarginMm: 3 }, 'bad'],
    ['coverage', { proximalMarginMm: 3, distalMarginMm: -2 }, 'bad'],
    ['coverage', { proximalMarginMm: null, distalMarginMm: null }, 'bad'],

    ['extra-stents', { stentsDeployed: 0 }, 'ok'],
    ['extra-stents', { stentsDeployed: 1 }, 'ok'],
    ['extra-stents', { stentsDeployed: 2 }, 'warn'],
    ['extra-stents', { stentsDeployed: 3 }, 'bad'],

    ['heparin', { heparin: 'before-wire' }, 'ok'],
    ['heparin', { heparin: 'late' }, 'warn'],
    ['heparin', { heparin: 'none' }, 'bad'],

    ['predilation', { predilated: true }, 'ok'],
    ['predilation', { predilated: false }, 'bad'],

    ['qca', { qcaUsed: true }, 'ok'],
    ['qca', { qcaUsed: false }, 'warn'],

    ['dissection', { dissection: 'none' }, 'ok'],
    ['dissection', { dissection: 'sealed' }, 'warn'],
    ['dissection', { dissection: 'unsealed' }, 'bad'],

    ['forcing', { wireForcingSeconds: 0.5 }, 'ok'],
    ['forcing', { wireForcingSeconds: 0.51 }, 'warn'],
    ['forcing', { wireForcingSeconds: 3 }, 'warn'],
    ['forcing', { wireForcingSeconds: 3.01 }, 'bad'],

    ['rupture', { balloonRuptures: 0 }, 'ok'],
    ['rupture', { balloonRuptures: 1 }, 'bad'],

    ['inflation', { longestInflationS: 30 }, 'ok'],
    ['inflation', { longestInflationS: 30.5 }, 'warn'],
    ['inflation', { longestInflationS: 60 }, 'warn'],
    ['inflation', { longestInflationS: 61 }, 'bad'],

    ['contrast', { contrastMl: 120 }, 'ok'],
    ['contrast', { contrastMl: 121 }, 'warn'],
    ['contrast', { contrastMl: 180 }, 'warn'],
    ['contrast', { contrastMl: 181 }, 'bad'],

    ['fluoro', { fluoroSeconds: 600 }, 'ok'],
    ['fluoro', { fluoroSeconds: 601 }, 'warn'],
    ['fluoro', { fluoroSeconds: 900 }, 'warn'],
    ['fluoro', { fluoroSeconds: 901 }, 'bad'],

    ['views', { finalViews: 3 }, 'ok'],
    ['views', { finalViews: 2 }, 'ok'],
    ['views', { finalViews: 1 }, 'warn'],
    ['views', { finalViews: 0 }, 'bad'],
  ];

  it.each(cases)('%s with %j is %s', (id, overrides, expected) => {
    expect(statusOf(withIt(overrides), id)).toBe(expected);
  });

  it('gives a warning half the points and a bad finding none', () => {
    const items = buildDebrief(withIt({ finalTimi: 2, heparin: 'none' })).items;
    const timi = items.find((i) => i.id === 'timi')!;
    const heparin = items.find((i) => i.id === 'heparin')!;
    expect(timi.points).toBe(timi.maxPoints / 2);
    expect(heparin.points).toBe(0);
  });

  it('keeps every item\'s points a whole number between 0 and its maximum', () => {
    for (const status of ['ok', 'warn', 'bad'] as const) {
      const bad = withIt({
        residualStenosis: status === 'ok' ? 0 : status === 'warn' ? 0.2 : 0.5,
        contrastMl: status === 'ok' ? 50 : status === 'warn' ? 150 : 300,
      });
      for (const i of buildDebrief(bad).items as DebriefItem[]) {
        expect(Number.isInteger(i.points)).toBe(true);
        expect(i.points).toBeGreaterThanOrEqual(0);
        expect(i.points).toBeLessThanOrEqual(i.maxPoints);
      }
    }
  });
});

describe('grades', () => {
  it('map the score at 90, 75 and 60', () => {
    expect(gradeFromScore(100)).toBe('Excellent');
    expect(gradeFromScore(90)).toBe('Excellent');
    expect(gradeFromScore(89)).toBe('Good');
    expect(gradeFromScore(75)).toBe('Good');
    expect(gradeFromScore(74)).toBe('Acceptable');
    expect(gradeFromScore(60)).toBe('Acceptable');
    expect(gradeFromScore(59)).toBe('Needs work');
    expect(gradeFromScore(0)).toBe('Needs work');
  });

  it('is Incomplete whenever the case was ended early, whatever the score', () => {
    const d = buildDebrief(withIt({ completed: false }));
    expect(d.grade).toBe('Incomplete');
    expect(d.score).toBe(100);
    expect(d.headline).toMatch(/^Incomplete/);
  });

  it('is Good for a sound result with some tidying to do', () => {
    // Five warnings: slow flow (-6), late heparin (-3), no QCA (-2), long fluoro (-2), much contrast (-2).
    const d = buildDebrief(withIt({ finalTimi: 2, contrastMl: 150, fluoroSeconds: 800, qcaUsed: false, heparin: 'late' }));
    expect(d.score).toBe(85);
    expect(d.grade).toBe('Good');
    expect(d.cappedBy).toEqual([]);
  });

  it('is capped at Needs work by an unsealed dissection, even though the score alone would pass', () => {
    const d = buildDebrief(withIt({ dissection: 'unsealed' }));
    expect(d.score).toBe(88);
    expect(gradeFromScore(d.score)).toBe('Good');
    expect(d.grade).toBe('Needs work');
    expect(d.cappedBy).toEqual(['unsealed dissection']);
    expect(d.headline).toMatch(/unsealed dissection/);
  });

  it('is capped by a balloon rupture, even at a score of 94', () => {
    const d = buildDebrief(withIt({ balloonRuptures: 1 }));
    expect(d.score).toBe(94);
    expect(d.grade).toBe('Needs work');
    expect(d.cappedBy).toEqual(['balloon rupture']);
  });

  it('is capped by a geographic miss, even at a score of 90', () => {
    const d = buildDebrief(withIt({ proximalMarginMm: -1, distalMarginMm: -1 }));
    expect(d.score).toBe(90);
    expect(d.grade).toBe('Needs work');
    expect(d.cappedBy).toEqual(['geographic miss']);
  });

  it('lists every cap that applies', () => {
    const d = buildDebrief(withIt({ dissection: 'unsealed', balloonRuptures: 2, distalMarginMm: -3 }));
    expect(d.cappedBy).toEqual(['unsealed dissection', 'balloon rupture', 'geographic miss']);
  });

  it('does not cap on a sealed dissection', () => {
    const d = buildDebrief(withIt({ dissection: 'sealed' }));
    expect(d.cappedBy).toEqual([]);
    expect(d.grade).toBe('Excellent');
  });

  it('still scores a case with nothing treated, without NaN, and calls it Needs work or Incomplete', () => {
    const nothing = buildDebrief({
      ...PERFECT,
      completed: true,
      residualStenosis: null, finalTimi: null, stentDiameterRatio: null,
      proximalMarginMm: null, distalMarginMm: null, stentsDeployed: 0,
    });
    expect(Number.isFinite(nothing.score)).toBe(true);
    expect(nothing.items.every((i) => Number.isFinite(i.points))).toBe(true);
    expect(nothing.grade).toBe('Needs work');
    expect(nothing.items.find((i) => i.id === 'coverage')!.value).toBe('no stent');
    expect(nothing.score).toBeLessThan(60);
  });

  it('is pure: the same summary gives the same debrief', () => {
    expect(buildDebrief(PERFECT)).toEqual(buildDebrief({ ...PERFECT }));
  });
});
