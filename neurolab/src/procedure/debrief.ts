/**
 * The debrief: a teaching score for a case, as pure functions. `summarise` reads the field state into a few plain facts;
 * `debrief` turns those into scored items, a grade and tips. The weights and thresholds are teaching choices, not an
 * assessment standard (see DESIGN-NOTES.md), and the wording comes from the language tables.
 */
import { RULES } from '../config/rules';
import { t } from '../i18n';
import { evaluateClip, type ClipResult } from '../physics/clipEval';
import type { FieldState } from './field';
import { stageViews } from './stages';

export interface CaseSummary {
  readonly seconds: number;
  readonly eblMl: number;
  readonly tempClipTotalSeconds: number;
  readonly retractionSeconds: number;
  readonly ruptured: boolean;
  readonly injuries: number;
  readonly clip: ClipResult | null;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly mepMin: number;
  /** A rupture that was brought under control: the sac is clipped and closed. */
  readonly controlled: boolean;
}

export function summarise(state: FieldState): CaseSummary {
  const views = stageViews(state);
  const clip = state.clip ? evaluateClip(state.clip) : null;
  return {
    seconds: state.time,
    eblMl: state.ebl,
    tempClipTotalSeconds: state.tempClip.totalSeconds,
    retractionSeconds: state.retractionSeconds,
    ruptured: state.ruptured,
    injuries: state.injuries.filter((i) => i.kind !== 'rupture').length,
    clip,
    stepsDone: views.filter((v) => v.status === 'done').length,
    stepsTotal: views.length,
    mepMin: state.vitals.mepMin,
    controlled: clip !== null && clip.closed,
  };
}

export type Grade = 'excellent' | 'good' | 'fair' | 'needsWork';

export interface DebriefItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly points: number;
  readonly max: number;
  readonly tone: 'good' | 'warn' | 'bad' | 'normal';
}

export interface Debrief {
  readonly score: number;
  readonly grade: Grade;
  readonly gradeLabel: string;
  readonly summary: string;
  readonly items: readonly DebriefItem[];
  readonly tips: readonly string[];
}

/** The most a case with no clip can score. */
export const NO_CLIP_CAP = 49;

/** The weights add to 100. */
export const WEIGHTS = { clip: 35, rupture: 20, blood: 10, temp: 10, injuries: 10, steps: 10, retraction: 5 } as const;

const toneFor = (points: number, max: number): DebriefItem['tone'] => (points >= max ? 'good' : points >= max / 2 ? 'warn' : 'bad');
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function gradeFor(score: number): Grade {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'needsWork';
}

function clipPoints(c: ClipResult | null): number {
  if (!c) return 0;
  const k = RULES.clip;
  let points = 0;
  if (c.closed) points += 15;
  if (c.pcomOpen) points += 5;
  if (c.achoaOpen) points += 5;
  points += c.icaNarrowingPct < k.noticeNarrowingPct ? 10 : c.icaNarrowingPct < k.blockNarrowingPct ? 5 : 0;
  return points;
}

function clipValue(c: ClipResult | null): string {
  if (!c) return t('value.clip.none');
  const problems: string[] = [];
  if (!c.closed) problems.push(t('value.clip.open', { mm: c.residualMm.toFixed(1) }));
  if (!c.pcomOpen) problems.push(t('value.clip.pcom'));
  if (!c.achoaOpen) problems.push(t('value.clip.achoa'));
  if (c.icaNarrowingPct >= RULES.clip.noticeNarrowingPct) problems.push(t('value.clip.narrow', { pct: Math.round(c.icaNarrowingPct) }));
  return problems.length === 0 ? t('value.clip.good') : problems.join('; ');
}

function bloodPoints(ml: number): number {
  if (ml < 100) return WEIGHTS.blood;
  if (ml < 300) return 7;
  if (ml < 800) return 4;
  return 0;
}

function tempPoints(seconds: number): number {
  if (seconds <= 120) return WEIGHTS.temp;
  if (seconds <= RULES.tempClipWarnSeconds) return 7;
  if (seconds <= RULES.tempClipLongSeconds) return 3;
  return 0;
}

export function debrief(s: CaseSummary): Debrief {
  const rupturePoints = !s.ruptured ? WEIGHTS.rupture : s.controlled ? 5 : 0;
  const injuryPoints = Math.max(0, WEIGHTS.injuries - 5 * s.injuries);
  const stepPoints = Math.round((WEIGHTS.steps * s.stepsDone) / s.stepsTotal);
  const retractionPoints = s.retractionSeconds <= RULES.retractionWarnSeconds ? WEIGHTS.retraction : 2;

  const items: DebriefItem[] = [
    { id: 'clip', label: t('item.clip'), value: clipValue(s.clip), points: clipPoints(s.clip), max: WEIGHTS.clip, tone: toneFor(clipPoints(s.clip), WEIGHTS.clip) },
    {
      id: 'rupture',
      label: t('item.rupture'),
      value: t(!s.ruptured ? 'value.rupture.no' : s.controlled ? 'value.rupture.controlled' : 'value.rupture.uncontrolled'),
      points: rupturePoints,
      max: WEIGHTS.rupture,
      tone: toneFor(rupturePoints, WEIGHTS.rupture),
    },
    { id: 'blood', label: t('item.blood'), value: t('value.ml', { ml: Math.round(s.eblMl) }), points: bloodPoints(s.eblMl), max: WEIGHTS.blood, tone: toneFor(bloodPoints(s.eblMl), WEIGHTS.blood) },
    {
      id: 'temp',
      label: t('item.temp'),
      value: s.tempClipTotalSeconds > 0 ? t('value.seconds', { s: Math.round(s.tempClipTotalSeconds) }) : t('value.none'),
      points: tempPoints(s.tempClipTotalSeconds),
      max: WEIGHTS.temp,
      tone: toneFor(tempPoints(s.tempClipTotalSeconds), WEIGHTS.temp),
    },
    { id: 'injuries', label: t('item.injuries'), value: s.injuries === 0 ? t('value.none') : t('value.count', { n: s.injuries }), points: injuryPoints, max: WEIGHTS.injuries, tone: toneFor(injuryPoints, WEIGHTS.injuries) },
    { id: 'steps', label: t('item.steps'), value: t('value.stepsOf', { done: s.stepsDone, total: s.stepsTotal }), points: stepPoints, max: WEIGHTS.steps, tone: toneFor(stepPoints, WEIGHTS.steps) },
    {
      id: 'retraction',
      label: t('item.retraction'),
      value: t('value.seconds', { s: Math.round(s.retractionSeconds) }),
      points: retractionPoints,
      max: WEIGHTS.retraction,
      tone: toneFor(retractionPoints, WEIGHTS.retraction),
    },
    // Facts that carry no points of their own.
    { id: 'time', label: t('item.time'), value: clock(s.seconds), points: 0, max: 0, tone: 'normal' },
    { id: 'mep', label: t('item.mep'), value: t('value.percent', { pct: Math.round(s.mepMin) }), points: 0, max: 0, tone: s.mepMin < RULES.vitals.lowMep ? 'bad' : 'normal' },
  ];

  // An aneurysm that was never clipped is untreated, however little went wrong around it, so it can never pass.
  const raw = Math.round(items.reduce((sum, item) => sum + item.points, 0));
  const score = s.clip ? raw : Math.min(raw, NO_CLIP_CAP);
  const grade = gradeFor(score);

  const tips: string[] = [];
  if (s.ruptured) tips.push(t('tip.rupture'));
  if (s.ruptured && !s.controlled) tips.push(t('tip.ruptureUncontrolled'));
  if (!s.clip) tips.push(t('tip.noClip'));
  else {
    if (!s.clip.closed) tips.push(t('tip.open'));
    if (!s.clip.pcomOpen) tips.push(t('tip.pcom'));
    if (!s.clip.achoaOpen) tips.push(t('tip.achoa'));
    if (s.clip.icaNarrowingPct >= RULES.clip.noticeNarrowingPct) tips.push(t('tip.narrow'));
  }
  if (s.tempClipTotalSeconds > RULES.tempClipWarnSeconds) tips.push(t('tip.temp'));
  if (s.eblMl >= 300) tips.push(t('tip.blood'));
  if (s.injuries > 0) tips.push(t('tip.injuries'));
  if (s.stepsDone < s.stepsTotal) tips.push(t('tip.steps'));
  if (s.retractionSeconds > RULES.retractionWarnSeconds) tips.push(t('tip.retraction'));
  if (tips.length === 0) tips.push(t('tip.clean'));

  return { score, grade, gradeLabel: t(`grade.${grade}`), summary: t(`grade.summary.${grade}`), items, tips };
}
